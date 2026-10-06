// Servidor de sincronização do WatchParty.
//
// WebSocket puro (biblioteca "ws"), sem Express. Nenhum vídeo passa por aqui:
// só trafegam comandos de sincronização (play/pause/tempo/URL) e mensagens de chat.
//
// Protocolo (JSON, campo "type"):
//   cliente → servidor: create_room, join_room, leave_room, sync, chat, ping
//   servidor → cliente: room_created, room_joined, room_left, participant_joined,
//                       participant_left, host_changed, sync, chat, pong, error
import { WebSocketServer } from "ws";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.PORT) || 8080;
const HEARTBEAT_MS = 30_000;
const MAX_NAME = 32;
const MAX_CHAT = 500;
const MAX_URL = 2048;
// Sem 0/O, 1/I/L para o código ser fácil de ditar.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
// Se o host cair (celular trocou de rede, aba dormiu), ele tem este tempo para voltar e recuperar o papel.
const HOST_RESUME_MS = 90_000;
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");

/** @type {Map<string, Room>} */
const rooms = new Map();

/**
 * @typedef {{ id: string, name: string, ws: import("ws").WebSocket, joinedAt: number }} Participant
 * @typedef {{ paused: boolean, currentTime: number, updatedAt: number, url: string | null }} RoomState
 * @typedef {{ code: string, hostId: string, participants: Map<string, Participant>, state: RoomState, createdAt: number }} Room
 */

function generateCode() {
  let code;
  do {
    code = "";
    const bytes = crypto.randomBytes(6);
    for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  } while (rooms.has(code));
  return code;
}

function cleanName(name) {
  const n = String(name ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  return n || "Anônimo";
}

function cleanUrl(url) {
  if (url == null) return null;
  const u = String(url).trim().slice(0, MAX_URL);
  return /^https?:\/\//i.test(u) ? u : null;
}

function send(ws, message) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

function sendError(ws, code, message) {
  send(ws, { type: "error", code, message });
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    participants: [...room.participants.values()]
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map((p) => ({ id: p.id, name: p.name })),
    state: room.state,
  };
}

function broadcast(room, message, { except } = {}) {
  for (const p of room.participants.values()) {
    if (p.id !== except) send(p.ws, message);
  }
}

function createRoom(host) {
  /** @type {Room} */
  const room = {
    code: generateCode(),
    hostId: host.id,
    participants: new Map([[host.id, host]]),
    state: { paused: true, currentTime: 0, updatedAt: Date.now(), url: null },
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

// Tira o cliente da sala em que está (se estiver), avisa os outros,
// passa o host adiante e apaga a sala se ficou vazia.
function leaveRoom(client, { notifySelf = true } = {}) {
  const room = client.room;
  if (!room) return;
  client.room = null;
  room.participants.delete(client.id);

  if (room.participants.size === 0) {
    rooms.delete(room.code);
    log(`sala ${room.code} apagada (vazia)`);
  } else {
    let newHostId = null;
    if (room.hostId === client.id) {
      // O participante mais antigo vira host; o antigo pode recuperar o papel se voltar logo (previousId).
      const oldest = [...room.participants.values()].sort((a, b) => a.joinedAt - b.joinedAt)[0];
      room.hostId = oldest.id;
      newHostId = oldest.id;
      room.formerHost = { id: client.id, until: Date.now() + HOST_RESUME_MS };
    }
    broadcast(room, { type: "participant_left", participant: { id: client.id, name: client.name }, hostId: room.hostId });
    if (newHostId) broadcast(room, { type: "host_changed", hostId: newHostId, reason: "host_left" });
  }
  if (notifySelf) send(client.ws, { type: "room_left", code: room.code });
}

function handleMessage(client, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return sendError(client.ws, "bad_json", "Mensagem não é JSON válido.");
  }
  if (!msg || typeof msg.type !== "string") return sendError(client.ws, "bad_message", "Faltou o campo \"type\".");

  switch (msg.type) {
    case "ping":
      return send(client.ws, { type: "pong", t: Date.now() });

    case "create_room": {
      leaveRoom(client, { notifySelf: false });
      client.name = cleanName(msg.name);
      const room = createRoom(client);
      client.room = room;
      log(`sala ${room.code} criada por ${client.name}`);
      return send(client.ws, { type: "room_created", you: { id: client.id, name: client.name }, room: publicRoom(room) });
    }

    case "join_room": {
      const code = String(msg.code ?? "").trim().toUpperCase();
      const room = rooms.get(code);
      if (!room) return sendError(client.ws, "room_not_found", "Sala não encontrada. Confira o código.");
      if (client.room === room) return send(client.ws, { type: "room_joined", you: { id: client.id, name: client.name }, room: publicRoom(room) });
      leaveRoom(client, { notifySelf: false });
      client.name = cleanName(msg.name);
      client.joinedAt = Date.now();
      client.room = room;
      room.participants.set(client.id, client);
      log(`${client.name} entrou na sala ${code}`);
      // Host que caiu e voltou a tempo recupera o papel.
      let hostBack = false;
      if (room.formerHost && msg.previousId === room.formerHost.id && Date.now() < room.formerHost.until) {
        room.hostId = client.id;
        room.formerHost = null;
        hostBack = true;
      }
      // O novo cliente recebe o estado atual (inclusive a URL) e a lista de participantes.
      send(client.ws, { type: "room_joined", you: { id: client.id, name: client.name }, room: publicRoom(room) });
      broadcast(room, { type: "participant_joined", participant: { id: client.id, name: client.name } }, { except: client.id });
      if (hostBack) broadcast(room, { type: "host_changed", hostId: client.id, reason: "host_back" }, { except: client.id });
      return;
    }

    case "leave_room":
      if (!client.room) return sendError(client.ws, "not_in_room", "Você não está em nenhuma sala.");
      return leaveRoom(client);

    case "sync": {
      const room = client.room;
      if (!room) return sendError(client.ws, "not_in_room", "Você não está em nenhuma sala.");
      if (room.hostId !== client.id) return sendError(client.ws, "not_host", "Só o host pode sincronizar o vídeo.");
      const currentTime = Number(msg.currentTime);
      if (!Number.isFinite(currentTime) || currentTime < 0) return sendError(client.ws, "bad_sync", "currentTime inválido.");
      room.state = {
        paused: Boolean(msg.paused),
        currentTime,
        updatedAt: Date.now(),
        url: cleanUrl(msg.url) ?? room.state.url,
      };
      return broadcast(room, { type: "sync", ...room.state }, { except: client.id });
    }

    case "chat": {
      const room = client.room;
      if (!room) return sendError(client.ws, "not_in_room", "Você não está em nenhuma sala.");
      const text = String(msg.text ?? "").trim().slice(0, MAX_CHAT);
      if (!text) return;
      return broadcast(room, { type: "chat", from: { id: client.id, name: client.name }, text, timestamp: Date.now() });
    }

    case "reaction": {
      // Reação rápida (coração, risada...) mostrada por cima do vídeo de todos.
      const room = client.room;
      if (!room) return sendError(client.ws, "not_in_room", "Você não está em nenhuma sala.");
      const emoji = String(msg.emoji ?? "").trim().slice(0, 8);
      if (!emoji) return;
      return broadcast(room, { type: "reaction", from: { id: client.id, name: client.name }, emoji, timestamp: Date.now() });
    }

    default:
      return sendError(client.ws, "unknown_type", `Tipo de mensagem desconhecido: ${msg.type}`);
  }
}

function log(...args) {
  if (process.env.NODE_ENV !== "test") console.log(new Date().toISOString(), ...args);
}

// ---------- Servidor ----------

// HTTP: health check, o site do modo web (public/) e o upgrade do WebSocket.
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".webmanifest": "application/manifest+json" };

function serveStatic(req, res) {
  let pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
  // /s/ABC123 é o link da sala: a própria página lê o código da URL.
  if (pathname === "/" || pathname.startsWith("/s/")) pathname = "/index.html";
  const file = path.normalize(path.join(PUBLIC_DIR, pathname));
  if (!file.startsWith(PUBLIC_DIR)) return res.writeHead(403).end();
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()) return res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Não encontrado");
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": pathname === "/index.html" ? "no-cache" : "public, max-age=3600" });
    fs.createReadStream(file).pipe(res);
  });
}

const httpServer = http.createServer((req, res) => {
  if (req.url === "/config.json") {
    // Chave pública da API do Google (restrinja por site no Google Cloud): permite tocar vídeos do Drive.
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-cache" });
    return res.end(JSON.stringify({ googleApiKey: process.env.GOOGLE_API_KEY || "" }));
  }
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "access-control-allow-origin": "*" });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return res.writeHead(405).end();
  serveStatic(req, res);
});

const wss = new WebSocketServer({ server: httpServer });

/** @type {Map<import("ws").WebSocket, object>} */
const clients = new Map();

wss.on("connection", (ws, req) => {
  const client = { id: crypto.randomUUID(), name: "Anônimo", ws, room: null, joinedAt: Date.now(), isAlive: true };
  clients.set(ws, client);
  ws.on("pong", () => {
    client.isAlive = true;
  });
  ws.on("message", (data) => {
    // Limita o tamanho para ninguém derrubar o servidor com mensagens gigantes.
    if (data.length > 16 * 1024) return sendError(ws, "too_big", "Mensagem grande demais.");
    handleMessage(client, data.toString());
  });
  ws.on("close", () => {
    clients.delete(ws);
    leaveRoom(client, { notifySelf: false });
  });
  ws.on("error", (err) => log("erro no socket:", err.message));
  send(ws, { type: "hello", id: client.id, heartbeatMs: HEARTBEAT_MS });
  log(`conexão de ${req.socket.remoteAddress}`);
});

// Heartbeat: a cada 30s manda ping; quem não respondeu ao anterior é derrubado
// (o evento "close" do socket derrubado tira o cliente da sala).
const heartbeat = setInterval(() => {
  for (const [ws, client] of clients) {
    if (!client.isAlive) {
      ws.terminate();
      continue;
    }
    client.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_MS);
heartbeat.unref();

export function start() {
  return new Promise((resolve) => {
    httpServer.listen(PORT, () => {
      log(`CineCasal: site em http://localhost:${PORT} e WebSocket em ws://localhost:${PORT}`);
      resolve(httpServer);
    });
  });
}

export function stop() {
  clearInterval(heartbeat);
  for (const ws of wss.clients) ws.terminate();
  return new Promise((resolve) => httpServer.close(() => resolve()));
}

export { rooms, httpServer, wss };

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  start();
}
