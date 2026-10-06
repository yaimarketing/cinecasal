// Service worker da extensão WatchParty (Manifest V3).
//
// Mantém a ÚNICA conexão WebSocket com o servidor e faz a ponte entre o servidor,
// os content scripts (abas do YouTube/Netflix/Prime/Max) e o popup, via chrome.runtime.
//
// Sobrevivência: service workers MV3 são encerrados após ~30s ociosos. A partir do
// Chrome 116, trocar mensagens pelo WebSocket renova esse prazo, então mandamos um
// "ping" JSON a cada 20s enquanto estivermos numa sala. Além disso, o estado da
// sessão fica em chrome.storage.session: se o worker for reiniciado (troca de aba,
// inatividade, etc.), ele reconecta e entra de novo na mesma sala sozinho.

// Servidor público (render.yaml deste repositório). Para testar localmente, troque no popup para ws://localhost:8080.
const DEFAULT_SERVER = "wss://cinecasal.onrender.com";
const SITE_PATTERNS = ["*://*.youtube.com/*", "*://*.netflix.com/*", "*://*.primevideo.com/*", "*://*.max.com/*", "*://*.hbomax.com/*"];
const PING_MS = 20_000;
const MAX_MESSAGES = 200;
const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/** Estado em memória (espelhado em chrome.storage.session). */
const session = {
  serverUrl: DEFAULT_SERVER,
  name: "",
  status: "disconnected", // disconnected | connecting | connected
  room: null, // { code, hostId, participants: [{id, name}], state: {paused, currentTime, updatedAt, url} }
  you: null, // { id, name }
  messages: [], // [{ id, kind: "chat"|"system", from?, text, timestamp }]
  lastError: null,
  wantRoom: null, // { code, name } — sala em que devemos estar (para reentrar após reconectar)
};

let ws = null;
let pingTimer = null;
let reconnectTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let queue = []; // mensagens a enviar assim que a conexão abrir
// Em modo "split" (janela anônima com o próprio worker), cada lado guarda a própria sessão.
const SESSION_KEY = chrome.extension?.inIncognitoContext ? "session-incognito" : "session";
let restored = loadSession();

// ---------- Persistência ----------

async function loadSession() {
  const local = await chrome.storage.local.get(["serverUrl", "name"]);
  if (local.serverUrl) session.serverUrl = local.serverUrl;
  if (local.name) session.name = local.name;
  const saved = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (saved) {
    session.room = saved.room ?? null;
    session.you = saved.you ?? null;
    session.messages = saved.messages ?? [];
    session.wantRoom = saved.wantRoom ?? null;
  }
  if (session.wantRoom) ensureConnected();
}

function persist() {
  const { room, you, messages, wantRoom } = session;
  chrome.storage.session.set({ [SESSION_KEY]: { room, you, messages, wantRoom } }).catch(() => {});
}

// ---------- Snapshot enviado para popup e content scripts ----------

function snapshot() {
  return {
    serverUrl: session.serverUrl,
    name: session.name,
    status: session.status,
    room: session.room,
    you: session.you,
    isHost: Boolean(session.room && session.you && session.room.hostId === session.you.id),
    messages: session.messages,
    lastError: session.lastError,
  };
}

function broadcastState() {
  persist();
  broadcastToTabs({ type: "state", snapshot: snapshot() });
  // Popup (se estiver aberto). Sem ouvinte, dá erro silencioso.
  chrome.runtime.sendMessage({ type: "state", snapshot: snapshot() }).catch(() => {});
}

async function broadcastToTabs(message) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: SITE_PATTERNS });
  } catch {
    return;
  }
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, message).catch(() => {}); // aba sem content script ainda
  }
}

function addMessage(msg) {
  session.messages.push({ id: crypto.randomUUID(), ...msg });
  if (session.messages.length > MAX_MESSAGES) session.messages.splice(0, session.messages.length - MAX_MESSAGES);
}

function systemMessage(text) {
  addMessage({ kind: "system", text, timestamp: Date.now() });
}

function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h ? String(m).padStart(2, "0") : String(m);
  return `${h ? h + ":" : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

function participantName(id) {
  return session.room?.participants.find((p) => p.id === id)?.name || "alguém";
}

// Atualiza o estado da sala e gera as mensagens de sistema ("Host deu play em 12:34", ...).
function applySyncToState(next) {
  const room = session.room;
  if (!room) return;
  const prev = room.state || { paused: true, currentTime: 0, updatedAt: Date.now(), url: null };
  const state = { paused: Boolean(next.paused), currentTime: Number(next.currentTime) || 0, updatedAt: next.updatedAt || Date.now(), url: next.url ?? prev.url ?? null };
  room.state = state;

  const t = formatTime(state.currentTime);
  if (state.url && prev.url && state.url !== prev.url) {
    systemMessage("Host trocou para outro vídeo");
  } else if (state.paused !== prev.paused) {
    systemMessage(state.paused ? `Host pausou em ${t}` : `Host deu play em ${t}`);
  } else {
    // Mesmo estado de play/pause: foi um seek? Compara com o tempo esperado pelo relógio.
    const elapsed = prev.paused ? 0 : (state.updatedAt - prev.updatedAt) / 1000;
    const expected = prev.currentTime + elapsed;
    if (Math.abs(state.currentTime - expected) > 2) systemMessage(`Host pulou para ${t}`);
  }
}

// ---------- WebSocket ----------

function ensureConnected() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  clearTimeout(reconnectTimer);
  session.status = "connecting";
  session.lastError = null;
  broadcastState();

  let socket;
  try {
    socket = new WebSocket(session.serverUrl);
  } catch (err) {
    session.status = "disconnected";
    session.lastError = `Endereço do servidor inválido: ${session.serverUrl}`;
    broadcastState();
    return;
  }
  ws = socket;

  socket.addEventListener("open", () => {
    if (ws !== socket) return;
    session.status = "connected";
    reconnectDelay = RECONNECT_MIN_MS;
    // Reentra na sala em que estávamos (reconexão ou reinício do worker).
    if (session.wantRoom && session.room) {
      sendToServer({
        type: "join_room",
        code: session.wantRoom.code,
        name: session.wantRoom.name,
        previousId: session.you?.id,
        // Se o servidor reiniciou, recria a sala com o último estado conhecido.
        recreate: { hostId: session.room.hostId, state: session.room.state },
      });
    }
    for (const m of queue) sendToServer(m);
    queue = [];
    startPing();
    broadcastState();
  });

  socket.addEventListener("message", (ev) => {
    if (ws !== socket) return;
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    handleServerMessage(msg);
  });

  socket.addEventListener("close", () => {
    if (ws !== socket) return;
    ws = null;
    stopPing();
    session.status = "disconnected";
    broadcastState();
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    if (ws !== socket) return;
    session.lastError = `Não consegui conectar em ${session.serverUrl}. O servidor está rodando?`;
    // O evento "close" vem em seguida e agenda a reconexão.
  });
}

function scheduleReconnect() {
  if (!session.wantRoom && queue.length === 0) return; // sem sala, não há motivo para reconectar
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(ensureConnected, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

function disconnect() {
  clearTimeout(reconnectTimer);
  stopPing();
  queue = [];
  const socket = ws;
  ws = null;
  try {
    socket?.close();
  } catch {}
  session.status = "disconnected";
}

function sendToServer(message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  } else {
    queue.push(message);
    ensureConnected();
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
  }, PING_MS);
}

function stopPing() {
  clearInterval(pingTimer);
  pingTimer = null;
}

// Alarme de segurança: se o worker reiniciar sem o ping (Chrome antigo, suspensão do PC),
// o alarme acorda o worker, que relê a sessão e reconecta.
chrome.alarms.create("watchparty-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "watchparty-keepalive") return;
  await restored;
  if (session.wantRoom) ensureConnected();
});

// ---------- Mensagens do servidor ----------

function handleServerMessage(msg) {
  switch (msg.type) {
    case "hello":
    case "pong":
      return;

    case "room_created":
    case "room_joined": {
      const rejoin = session.room?.code === msg.room.code;
      session.room = msg.room;
      session.you = msg.you;
      session.wantRoom = { code: msg.room.code, name: msg.you.name };
      session.lastError = null;
      if (msg.type === "room_created") systemMessage(`Você criou a sala ${msg.room.code}. Compartilhe o código com seus amigos.`);
      else if (!rejoin) systemMessage(`Você entrou na sala ${msg.room.code}.`);
      else systemMessage("Reconectado à sala.");
      broadcastState();
      broadcastToTabs({ type: "server", message: msg });
      return;
    }

    case "room_left":
      clearRoom();
      return;

    case "participant_joined":
      if (!session.room) return;
      if (!session.room.participants.some((p) => p.id === msg.participant.id)) session.room.participants.push(msg.participant);
      systemMessage(`${msg.participant.name} entrou`);
      broadcastState();
      broadcastToTabs({ type: "server", message: msg });
      return;

    case "participant_left":
      if (!session.room) return;
      session.room.participants = session.room.participants.filter((p) => p.id !== msg.participant.id);
      if (msg.hostId) session.room.hostId = msg.hostId;
      systemMessage(`${msg.participant.name} saiu`);
      broadcastState();
      return;

    case "host_changed":
      if (!session.room) return;
      session.room.hostId = msg.hostId;
      systemMessage(msg.hostId === session.you?.id ? "Você agora é o host" : `${participantName(msg.hostId)} agora é o host`);
      broadcastState();
      broadcastToTabs({ type: "server", message: msg });
      return;

    case "sync":
      applySyncToState(msg);
      broadcastState();
      broadcastToTabs({ type: "server", message: msg });
      return;

    case "chat":
      addMessage({ kind: "chat", from: msg.from, text: msg.text, timestamp: msg.timestamp });
      broadcastState();
      return;

    case "error":
      session.lastError = msg.message;
      if (msg.code === "room_not_found" && session.wantRoom) {
        // A sala que queríamos reentrar não existe mais (todos saíram).
        systemMessage("A sala não existe mais.");
        clearRoom({ keepMessages: true });
      }
      broadcastState();
      return;
  }
}

function clearRoom({ keepMessages = false } = {}) {
  session.room = null;
  session.you = null;
  session.wantRoom = null;
  if (!keepMessages) session.messages = [];
  broadcastState();
  broadcastToTabs({ type: "server", message: { type: "room_left" } });
  disconnect();
}

// ---------- Mensagens do popup e dos content scripts ----------

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  restored.then(() => handleRuntimeMessage(msg, sender)).then(sendResponse, (err) => sendResponse({ error: String(err) }));
  return true; // resposta assíncrona
});

async function handleRuntimeMessage(msg, sender) {
  switch (msg.type) {
    case "get_state":
      return snapshot();

    case "set_server": {
      const url = String(msg.url || DEFAULT_SERVER).trim();
      if (!/^wss?:\/\//.test(url)) return { error: "O endereço deve começar com ws:// ou wss://" };
      session.serverUrl = url;
      await chrome.storage.local.set({ serverUrl: url });
      disconnect();
      if (session.wantRoom) ensureConnected();
      broadcastState();
      return snapshot();
    }

    case "create_room":
    case "join_room": {
      const name = String(msg.name || "").trim().slice(0, 32) || "Anônimo";
      session.name = name;
      await chrome.storage.local.set({ name });
      session.lastError = null;
      if (msg.type === "create_room") {
        session.wantRoom = null; // ainda não sabemos o código
        sendToServer({ type: "create_room", name });
      } else {
        const code = String(msg.code || "").trim().toUpperCase();
        if (!/^[A-Z0-9]{6}$/.test(code)) return { error: "O código da sala tem 6 letras/números." };
        sendToServer({ type: "join_room", code, name });
      }
      broadcastState();
      return snapshot();
    }

    case "leave_room":
      if (ws && ws.readyState === WebSocket.OPEN && session.room) {
        ws.send(JSON.stringify({ type: "leave_room" }));
      }
      clearRoom();
      return snapshot();

    case "sync": {
      // Só o host sincroniza. A URL de verdade é a da aba (o content script pode estar num iframe).
      if (!snapshot().isHost) return { ignored: true };
      const url = sender.tab?.url || msg.url || null;
      const state = { paused: Boolean(msg.paused), currentTime: Number(msg.currentTime) || 0, url, updatedAt: Date.now() };
      applySyncToState(state);
      sendToServer({ type: "sync", paused: state.paused, currentTime: state.currentTime, url });
      broadcastState();
      return { ok: true };
    }

    case "chat": {
      const text = String(msg.text || "").trim().slice(0, 500);
      if (!text || !session.room) return { error: "Você não está em uma sala." };
      sendToServer({ type: "chat", text });
      return { ok: true };
    }

    case "system":
      // Mensagem de sistema gerada localmente por um content script (ex.: "Você abriu o vídeo do host").
      if (msg.text) {
        systemMessage(String(msg.text).slice(0, 200));
        broadcastState();
      }
      return { ok: true };

    default:
      return { error: `Mensagem desconhecida: ${msg.type}` };
  }
}

chrome.runtime.onInstalled.addListener(() => {
  // Evita ficar sem alarme após instalar/atualizar.
  chrome.alarms.create("watchparty-keepalive", { periodInMinutes: 0.5 });
});
