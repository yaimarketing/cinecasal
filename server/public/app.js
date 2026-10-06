// CineCasal — modo web. Tudo numa página: sala, player (YouTube / vídeo do Drive ou link direto / relógio
// compartilhado), chat e reações. Fala com o servidor pelo mesmo protocolo da extensão (ver server.js).
(() => {
  const $ = (id) => document.getElementById(id);
  const WS_URL = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
  const SEEK_TOLERANCE = 1;
  const DRIFT_SYNC_MS = 10_000;
  const SYNC_DEBOUNCE_MS = 200;

  const state = {
    ws: null,
    status: "disconnected",
    name: localStorage.getItem("cc-name") || "",
    room: null,
    you: null,
    messages: [],
    config: { googleApiKey: "" },
    reconnectDelay: 1000,
    reconnectTimer: null,
    wantRoom: null, // { code, name, previousId }
    // player
    source: null, // { kind: "youtube"|"video"|"manual", id?, url, label }
    yt: null,
    ytReady: false,
    ytRoleHost: null,
    video: $("video"),
    ignoreUntil: 0,
    syncTimer: null,
    lastPoll: null,
  };

  const isHost = () => Boolean(state.room && state.you && state.room.hostId === state.you.id);

  // ---------- Utilidades ----------

  function fmtTime(sec) {
    const s = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    return `${h ? h + ":" : ""}${h ? String(m).padStart(2, "0") : m}:${String(r).padStart(2, "0")}`;
  }
  function parseTime(text) {
    const parts = String(text).trim().split(":").map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return null;
    return parts.reduce((acc, n) => acc * 60 + n, 0);
  }
  function fmtClock(ts) {
    return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  }
  function initials(name) {
    return name.trim().split(/\s+/).slice(0, 2).map((w) => w[0]?.toUpperCase() || "").join("") || "?";
  }
  // Tempo "ao vivo" do estado da sala: compensa o tempo desde o último sync se estiver tocando.
  function liveTime(st = state.room?.state) {
    if (!st) return 0;
    return st.currentTime + (st.paused ? 0 : Math.max(0, (Date.now() - st.updatedAt) / 1000));
  }

  // Identifica a fonte pela URL.
  function parseSource(url) {
    let u;
    try {
      u = new URL(url);
    } catch {
      return null;
    }
    const h = u.hostname.replace(/^www\./, "");
    if (h === "youtube.com" || h === "m.youtube.com" || h === "music.youtube.com" || h === "youtu.be") {
      const id = h === "youtu.be" ? u.pathname.slice(1).split("/")[0] : u.searchParams.get("v") || u.pathname.match(/\/(shorts|live|embed)\/([^/?]+)/)?.[2];
      if (id && /^[\w-]{6,}$/.test(id)) return { kind: "youtube", id, url, label: "YouTube" };
    }
    if (h === "drive.google.com" || h === "docs.google.com") {
      const id = u.pathname.match(/\/d\/([\w-]+)/)?.[1] || u.searchParams.get("id");
      if (id) return { kind: "video", drive: id, url, label: "Google Drive" };
    }
    if (/\.(mp4|webm|m4v|mov|ogv|mkv)(\?|$)/i.test(u.pathname + u.search) || u.searchParams.has("cc-video")) {
      return { kind: "video", src: url, url, label: "Vídeo" };
    }
    const label = h.includes("netflix") ? "Netflix" : h.includes("primevideo") || h.includes("amazon") ? "Prime Video" : h.includes("max.com") || h.includes("hbomax") ? "Max" : h.includes("disney") ? "Disney+" : h;
    return { kind: "manual", url, label };
  }

  // ---------- WebSocket ----------

  function connect() {
    if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) return;
    clearTimeout(state.reconnectTimer);
    setStatus("connecting");
    const ws = new WebSocket(WS_URL);
    state.ws = ws;
    ws.onopen = () => {
      if (state.ws !== ws) return;
      setStatus("connected");
      state.reconnectDelay = 1000;
      if (state.wantRoom) send({ type: "join_room", ...state.wantRoom, recreate: lastKnown() });
      for (const m of pending) send(m);
      pending.length = 0;
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      handleServer(msg);
    };
    ws.onclose = () => {
      if (state.ws !== ws) return;
      state.ws = null;
      setStatus("disconnected");
      if (state.wantRoom || pending.length) {
        state.reconnectTimer = setTimeout(connect, state.reconnectDelay);
        state.reconnectDelay = Math.min(state.reconnectDelay * 2, 15_000);
      }
    };
    ws.onerror = () => {};
  }
  const pending = [];
  function send(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify(msg));
    else {
      pending.push(msg);
      connect();
    }
  }
  setInterval(() => {
    if (state.ws?.readyState === WebSocket.OPEN) send({ type: "ping" });
  }, 25_000);

  // Último estado conhecido da sala (vídeo, tempo, quem era o host) para recriá-la se o servidor reiniciar.
  function lastKnown() {
    const r = state.room || JSON.parse(sessionStorage.getItem("cc-room-state") || "null");
    return r ? { hostId: r.hostId, state: r.state } : undefined;
  }
  function rememberRoom() {
    if (state.room) sessionStorage.setItem("cc-room-state", JSON.stringify({ hostId: state.room.hostId, state: state.room.state }));
  }

  function setStatus(s) {
    state.status = s;
    $("dot").className = `dot ${s}`;
    $("dot").title = { connected: "Conectado", connecting: "Conectando…", disconnected: "Desconectado, tentando reconectar" }[s];
  }

  // ---------- Mensagens do servidor ----------

  function handleServer(msg) {
    switch (msg.type) {
      case "room_created":
      case "room_joined": {
        const rejoin = state.room?.code === msg.room.code;
        state.room = msg.room;
        state.you = msg.you;
        state.wantRoom = { code: msg.room.code, name: msg.you.name, previousId: msg.you.id };
        sessionStorage.setItem("cc-room", JSON.stringify(state.wantRoom));
        history.replaceState(null, "", `/s/${msg.room.code}`);
        rememberRoom();
        if (msg.type === "room_created") system(`Sala ${msg.room.code} criada. Mande o link para quem vai assistir com você 💞`);
        else system(rejoin ? "Reconectado à sala." : `Você entrou na sala ${msg.room.code}.`);
        showRoom();
        renderAll();
        applyState(state.room.state, { initial: true });
        return;
      }
      case "participant_joined":
        if (!state.room.participants.some((p) => p.id === msg.participant.id)) state.room.participants.push(msg.participant);
        system(`${msg.participant.name} entrou 💕`);
        if (isHost()) sendSync(); // quem entrou recebe o estado fresco
        renderCouple();
        return;
      case "participant_left":
        state.room.participants = state.room.participants.filter((p) => p.id !== msg.participant.id);
        if (msg.hostId) state.room.hostId = msg.hostId;
        system(`${msg.participant.name} saiu`);
        renderCouple();
        renderRole();
        return;
      case "host_changed": {
        state.room.hostId = msg.hostId;
        const name = state.room.participants.find((p) => p.id === msg.hostId)?.name || "alguém";
        system(msg.hostId === state.you.id ? "Você agora é o host ★" : `${name} agora é o host ★`);
        rememberRoom();
        renderCouple();
        renderRole();
        return;
      }
      case "sync":
        noteStateChange(state.room.state, msg);
        state.room.state = { paused: msg.paused, currentTime: msg.currentTime, updatedAt: msg.updatedAt, url: msg.url };
        rememberRoom();
        applyState(state.room.state);
        return;
      case "chat":
        addMessage({ kind: "chat", from: msg.from, text: msg.text, timestamp: msg.timestamp });
        return;
      case "reaction":
        if (msg.emoji === "🎬") return countdown(msg.from.name);
        floatReaction(msg.emoji);
        return;
      case "room_left":
        leaveLocal();
        return;
      case "error":
        if (msg.code === "room_not_found") {
          if (state.wantRoom && state.room) {
            system("A sala não existe mais.");
            leaveLocal();
          } else showError($("home-error"), msg.message);
          state.wantRoom = null;
          return;
        }
        if (!state.room) showError($("home-error"), msg.message);
        else showError($("room-error"), msg.message);
        return;
    }
  }

  function showError(el, text) {
    el.textContent = text;
    el.hidden = false;
    clearTimeout(el._t);
    el._t = setTimeout(() => (el.hidden = true), 6000);
  }

  // ---------- Entrar / sair ----------

  function createRoom() {
    const name = $("name").value.trim();
    if (!name) return $("name").focus();
    localStorage.setItem("cc-name", name);
    state.wantRoom = null;
    send({ type: "create_room", name });
  }
  function joinRoom(code) {
    const name = $("name").value.trim();
    code = (code || $("code").value).trim().toUpperCase();
    if (!name) return $("name").focus();
    if (!/^[A-Z0-9]{6}$/.test(code)) return showError($("home-error"), "O código tem 6 letras ou números.");
    localStorage.setItem("cc-name", name);
    send({ type: "join_room", code, name });
  }
  function leaveRoom() {
    send({ type: "leave_room" });
    leaveLocal();
  }
  function leaveLocal() {
    state.room = null;
    state.you = null;
    state.wantRoom = null;
    state.messages = [];
    sessionStorage.removeItem("cc-room");
    sessionStorage.removeItem("cc-room-state");
    destroySource();
    history.replaceState(null, "", "/");
    $("view-room").hidden = true;
    $("view-home").hidden = false;
    $("messages").textContent = "";
    state.ws?.close();
  }
  function showRoom() {
    $("view-home").hidden = true;
    $("view-room").hidden = false;
    $("roomcode").textContent = state.room.code;
  }

  // ---------- Render ----------

  function renderAll() {
    renderCouple();
    renderRole();
    renderMessages();
  }

  function renderCouple() {
    const el = $("couple");
    el.textContent = "";
    const people = [...state.room.participants];
    const hostIdx = people.findIndex((p) => p.id === state.room.hostId);
    if (hostIdx > 0) people.unshift(...people.splice(hostIdx, 1));
    const [a, b, ...others] = people;
    const lover = (p) => {
      const d = document.createElement("div");
      if (!p) {
        d.className = "lover empty";
        d.innerHTML = `<div class="avatar">+</div><span class="lname">convide alguém</span>`;
        return d;
      }
      d.className = "lover" + (p.id === state.room.hostId ? " host" : "") + (p.id === state.you.id ? " you" : "");
      d.innerHTML = `<div class="avatar" style="position:relative">${initials(p.name)}</div><span class="lname"></span>`;
      d.querySelector(".lname").textContent = p.name + (p.id === state.you.id ? " (você)" : "");
      d.title = p.id === state.room.hostId ? "Host: controla o vídeo" : "";
      return d;
    };
    el.append(lover(a));
    const heart = document.createElement("span");
    heart.className = "heart";
    heart.textContent = "💞";
    el.append(heart, lover(b));
    if (others.length) {
      const o = document.createElement("div");
      o.className = "others";
      for (const p of others) {
        const s = document.createElement("span");
        s.textContent = p.name;
        o.append(s);
      }
      el.append(o);
    }
    const n = state.room.participants.length;
    $("people-count").textContent = `${n} na sala`;
  }

  function renderRole() {
    const host = isHost();
    $("host-bar").hidden = !host;
    $("manual-controls").hidden = !host;
    $("guest-hint").hidden = host;
    $("video-hint").hidden = host || state.source?.kind !== "video";
    if (state.video) state.video.controls = host;
    $("empty-text").textContent = host ? "Cole um link abaixo para começar 🍿" : "Esperando o host escolher o vídeo…";
    $("manual-help").textContent = host
      ? "Abra o vídeo no app e use os botões: o relógio de todos segue o seu."
      : "Abra o vídeo no app e acompanhe o relógio: quando o host der play, dê play também no mesmo ponto.";
    // Troca de papel: o player do YouTube precisa ser recriado para ligar/desligar os controles.
    if (state.source?.kind === "youtube" && state.yt && state.ytRoleHost !== host) mountYouTube(state.source.id);
  }

  function addMessage(m) {
    state.messages.push(m);
    if (state.messages.length > 300) state.messages.shift();
    renderMessages();
  }
  function system(text) {
    addMessage({ kind: "system", text, timestamp: Date.now() });
  }
  let renderedCount = 0;
  function renderMessages() {
    const box = $("messages");
    if (renderedCount > state.messages.length) {
      box.textContent = "";
      renderedCount = 0;
    }
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    for (const m of state.messages.slice(renderedCount)) {
      const el = document.createElement("div");
      if (m.kind === "system") {
        el.className = "msg system";
        el.textContent = m.text;
      } else {
        el.className = "msg" + (m.from.id === state.you?.id ? " mine" : "");
        const who = document.createElement("span");
        who.className = "who";
        who.textContent = m.from.name;
        const when = document.createElement("span");
        when.className = "when";
        when.textContent = fmtClock(m.timestamp);
        who.append(when);
        el.append(who, document.createTextNode(m.text));
      }
      box.append(el);
    }
    renderedCount = state.messages.length;
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function floatReaction(emoji) {
    const layer = $("reactions-layer");
    const s = document.createElement("span");
    s.textContent = emoji;
    s.style.left = `${10 + Math.random() * 80}%`;
    s.style.setProperty("--dx", `${(Math.random() - 0.5) * 80}px`);
    layer.append(s);
    setTimeout(() => s.remove(), 2500);
  }

  function countdown(byName) {
    const el = $("countdown");
    let n = 3;
    el.hidden = false;
    el.textContent = n;
    system(`${byName} começou a contagem 🎬`);
    const t = setInterval(() => {
      n--;
      if (n > 0) el.textContent = n;
      else {
        el.textContent = "PLAY!";
        clearInterval(t);
        setTimeout(() => (el.hidden = true), 700);
      }
    }, 1000);
  }

  // Mensagens de sistema a partir da mudança de estado (host local ou sync recebido).
  function noteStateChange(prev, next) {
    if (!prev) return;
    const t = fmtTime(next.currentTime);
    if (next.url && prev.url && next.url !== prev.url) system("Host trocou o vídeo");
    else if (!!next.paused !== !!prev.paused) system(next.paused ? `Host pausou em ${t}` : `Host deu play em ${t}`);
    else if (Math.abs(next.currentTime - liveTime(prev)) > 2) system(`Host pulou para ${t}`);
  }

  // ---------- Fonte / player ----------

  function destroySource() {
    if (state.yt) {
      try {
        state.yt.destroy();
      } catch {}
      state.yt = null;
      state.ytReady = false;
      $("player-youtube").insertAdjacentHTML("afterbegin", '<div id="yt"></div>');
    }
    if (state.video) {
      state.video.pause();
      state.video.removeAttribute("src");
      state.video.load();
    }
    state.source = null;
    for (const id of ["player-youtube", "player-video", "player-manual"]) $(id).hidden = true;
    $("player-empty").hidden = false;
  }

  function switchSource(url) {
    const src = parseSource(url);
    destroySource();
    if (!src) return;
    state.source = src;
    $("player-empty").hidden = true;
    if (src.kind === "youtube") {
      $("player-youtube").hidden = false;
      mountYouTube(src.id);
    } else if (src.kind === "video") {
      $("player-video").hidden = false;
      mountVideo(src);
    } else {
      $("player-manual").hidden = false;
      $("manual-service").textContent = `Modo relógio · ${src.label}`;
      $("manual-open").href = src.url;
      $("manual-open").textContent = `Abrir no ${src.label}`;
    }
    renderRole();
  }

  // Aplica o estado da sala (play/pause/tempo) no player atual; convidado só.
  function applyState(st, { initial = false } = {}) {
    if (!st) return;
    if (st.url && st.url !== state.source?.url) switchSource(st.url);
    if (!st.url) destroySource();
    if (isHost() && !initial) return;
    if (state.source?.kind === "youtube") applyYouTube(st);
    else if (state.source?.kind === "video") applyVideo(st);
    // modo relógio: o relógio lê state.room.state direto (tick abaixo)
  }

  // ----- YouTube (IFrame API) -----
  let ytApiPromise = null;
  function loadYouTubeApi() {
    if (window.YT?.Player) return Promise.resolve();
    if (ytApiPromise) return ytApiPromise;
    ytApiPromise = new Promise((resolve) => {
      window.onYouTubeIframeAPIReady = resolve;
      const s = document.createElement("script");
      s.src = "https://www.youtube.com/iframe_api";
      document.head.append(s);
    });
    return ytApiPromise;
  }

  async function mountYouTube(videoId) {
    const host = isHost();
    state.ytRoleHost = host;
    await loadYouTubeApi();
    if (state.source?.kind !== "youtube" || state.source.id !== videoId) return;
    if (state.yt) {
      try {
        state.yt.destroy();
      } catch {}
      $("player-youtube").insertAdjacentHTML("afterbegin", '<div id="yt"></div>');
    }
    state.ytReady = false;
    state.yt = new YT.Player("yt", {
      videoId,
      playerVars: { controls: host ? 1 : 0, disablekb: host ? 0 : 1, playsinline: 1, rel: 0, modestbranding: 1, origin: location.origin, enablejsapi: 1 },
      events: {
        onReady: () => {
          state.ytReady = true;
          if (!isHost()) applyYouTube(state.room.state);
          else state.lastPoll = null;
        },
        onStateChange: onYouTubeState,
      },
    });
  }

  function onYouTubeState(e) {
    const YTS = YT.PlayerState;
    if (isHost()) {
      if (e.data === YTS.PLAYING || e.data === YTS.PAUSED || e.data === YTS.ENDED) queueSync();
      return;
    }
    // Convidado: mantém alinhado com a sala (o usuário não tem controles, mas o YouTube pode pausar sozinho).
    if (Date.now() < state.ignoreUntil || !state.room) return;
    const st = state.room.state;
    if (e.data === YTS.PLAYING && st.paused) state.yt.pauseVideo();
    if (e.data === YTS.PAUSED && !st.paused) state.yt.playVideo();
    if (e.data === YTS.PLAYING) $("tap").hidden = true;
  }

  function applyYouTube(st) {
    if (!state.yt || !state.ytReady) return;
    state.ignoreUntil = Date.now() + 1500;
    const target = liveTime(st);
    if (Math.abs(state.yt.getCurrentTime() - target) > SEEK_TOLERANCE) state.yt.seekTo(target, true);
    if (st.paused) state.yt.pauseVideo();
    else {
      state.yt.playVideo();
      // Celular bloqueia play sem toque: mostra o botão.
      setTimeout(() => {
        if (!isHost() && !state.room?.state.paused && state.yt?.getPlayerState?.() !== YT.PlayerState.PLAYING) $("tap").hidden = false;
      }, 1200);
    }
  }

  // ----- <video> (Google Drive ou link direto) -----
  function mountVideo(src) {
    const v = state.video;
    v.controls = isHost();
    $("video-title").textContent = isHost() ? "" : "Só o host controla o vídeo.";
    let media = src.src;
    if (src.drive) {
      if (!state.config.googleApiKey) {
        showError($("room-error"), "Vídeos do Google Drive precisam da chave GOOGLE_API_KEY no servidor (veja o README).");
        return;
      }
      media = `https://www.googleapis.com/drive/v3/files/${src.drive}?alt=media&key=${encodeURIComponent(state.config.googleApiKey)}`;
      fetch(`https://www.googleapis.com/drive/v3/files/${src.drive}?fields=name&key=${encodeURIComponent(state.config.googleApiKey)}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((j) => ($("video-title").textContent = j.name))
        .catch((code) => showError($("room-error"), code === 404 || code === 403 ? "O Drive não liberou o arquivo: compartilhe como “Qualquer pessoa com o link”." : "Não consegui ler o arquivo no Drive."));
    }
    v.src = media;
    v.onerror = () => showError($("room-error"), "O navegador não conseguiu tocar esse vídeo (formato ou permissão).");
  }
  // Eventos locais do <video>: só contam quando somos o host (checado dentro).
  for (const ev of ["play", "pause", "seeked"]) state.video.addEventListener(ev, onLocalVideoEvent);
  function onLocalVideoEvent() {
    if (!isHost() || Date.now() < state.ignoreUntil) return;
    queueSync();
  }
  function applyVideo(st) {
    const v = state.video;
    if (!v.src) return;
    state.ignoreUntil = Date.now() + 1500;
    const target = liveTime(st);
    const doIt = () => {
      if (Math.abs(v.currentTime - target) > SEEK_TOLERANCE) v.currentTime = target;
      if (st.paused) v.pause();
      else v.play().then(() => ($("tap-video").hidden = true)).catch(() => ($("tap-video").hidden = false));
    };
    if (v.readyState >= 1) doIt();
    else v.addEventListener("loadedmetadata", doIt, { once: true });
  }

  // ----- Host: enviar sync -----
  function currentPlayback() {
    if (state.source?.kind === "youtube" && state.yt && state.ytReady) {
      const s = state.yt.getPlayerState();
      return { paused: s !== YT.PlayerState.PLAYING && s !== YT.PlayerState.BUFFERING, currentTime: state.yt.getCurrentTime() || 0 };
    }
    if (state.source?.kind === "video" && state.video.src) return { paused: state.video.paused, currentTime: state.video.currentTime };
    return { paused: state.room.state.paused, currentTime: liveTime() };
  }
  function queueSync() {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(sendSync, SYNC_DEBOUNCE_MS);
  }
  function sendSync(override) {
    if (!isHost()) return;
    const pb = override || currentPlayback();
    const next = { paused: pb.paused, currentTime: pb.currentTime, updatedAt: Date.now(), url: state.source?.url ?? state.room.state.url ?? null };
    noteStateChange(state.room.state, next);
    state.room.state = next;
    rememberRoom();
    send({ type: "sync", paused: next.paused, currentTime: next.currentTime, url: next.url });
  }
  // Seek do host no YouTube não gera evento: detecta pulo comparando com o tempo esperado.
  setInterval(() => {
    if (!isHost() || state.source?.kind !== "youtube" || !state.ytReady) return;
    const t = state.yt.getCurrentTime();
    const playing = state.yt.getPlayerState() === YT.PlayerState.PLAYING;
    const now = Date.now();
    if (state.lastPoll) {
      const expected = state.lastPoll.t + (state.lastPoll.playing ? (now - state.lastPoll.at) / 1000 : 0);
      if (Math.abs(t - expected) > 1.5) queueSync();
    }
    state.lastPoll = { t, at: now, playing };
  }, 500);
  // Correção de desvio: host reenvia o estado periodicamente enquanto toca.
  setInterval(() => {
    if (isHost() && state.room && !state.room.state.paused && state.source?.kind !== "manual") sendSync();
  }, DRIFT_SYNC_MS);

  // ----- Modo relógio -----
  setInterval(() => {
    if (state.source?.kind !== "manual" || !state.room) return;
    $("clock").textContent = fmtTime(liveTime());
    $("clock-state").textContent = state.room.state.paused ? "⏸ Pausado" : "▶ Tocando";
  }, 250);

  // ---------- Eventos da interface ----------

  $("create").addEventListener("click", createRoom);
  $("join").addEventListener("click", () => joinRoom());
  $("code").addEventListener("keydown", (e) => e.key === "Enter" && joinRoom());
  $("name").addEventListener("keydown", (e) => e.key === "Enter" && ($("code").value ? joinRoom() : createRoom()));
  $("leave").addEventListener("click", leaveRoom);
  $("share").addEventListener("click", async () => {
    const url = `${location.origin}/s/${state.room.code}`;
    const text = `Vem assistir comigo no CineCasal 💞 ${url}`;
    if (navigator.share) {
      try {
        await navigator.share({ title: "CineCasal", text, url });
        return;
      } catch {}
    }
    await navigator.clipboard?.writeText(url).catch(() => {});
    system("Link da sala copiado ✓");
  });

  $("host-bar").addEventListener("submit", (e) => {
    e.preventDefault();
    const url = $("video-url").value.trim();
    const src = parseSource(url);
    if (!src) return showError($("room-error"), "Cole um link válido (YouTube, Google Drive, ou da Netflix/Prime/Max).");
    $("video-url").value = "";
    switchSource(url);
    sendSync({ paused: true, currentTime: 0 });
  });

  $("compose").addEventListener("submit", (e) => {
    e.preventDefault();
    const text = $("text").value.trim();
    if (!text) return;
    $("text").value = "";
    send({ type: "chat", text });
  });
  for (const b of document.querySelectorAll(".reaction-bar button")) {
    b.addEventListener("click", () => send({ type: "reaction", emoji: b.dataset.emoji }));
  }

  $("tap").addEventListener("click", () => {
    $("tap").hidden = true;
    state.yt?.playVideo();
    applyYouTube(state.room.state);
  });
  $("tap-video").addEventListener("click", () => {
    $("tap-video").hidden = true;
    state.video.play().catch(() => {});
    applyVideo(state.room.state);
  });
  $("mute").addEventListener("click", () => {
    if (!state.yt) return;
    const muted = state.yt.isMuted();
    muted ? state.yt.unMute() : state.yt.mute();
    $("mute").textContent = muted ? "🔇 som" : "🔊 som";
  });
  $("mute-video").addEventListener("click", () => {
    state.video.muted = !state.video.muted;
    $("mute-video").textContent = state.video.muted ? "🔊 som" : "🔇 som";
  });

  // Controles do modo relógio (host)
  $("m-play").addEventListener("click", () => sendSync({ paused: false, currentTime: liveTime() }));
  $("m-pause").addEventListener("click", () => sendSync({ paused: true, currentTime: liveTime() }));
  $("m-set").addEventListener("click", () => {
    const t = parseTime($("m-time").value);
    if (t == null) return showError($("room-error"), "Digite o tempo como mm:ss (ex.: 12:34).");
    sendSync({ paused: state.room.state.paused, currentTime: t });
    $("m-time").value = "";
  });
  $("m-countdown").addEventListener("click", () => {
    send({ type: "reaction", emoji: "🎬" });
    setTimeout(() => sendSync({ paused: false, currentTime: liveTime() }), 3000);
  });

  // ---------- Início ----------

  fetch("/config.json").then((r) => r.json()).then((c) => (state.config = c)).catch(() => {});
  $("name").value = state.name;
  const codeFromUrl = location.pathname.match(/^\/s\/([A-Za-z0-9]{6})/)?.[1] || new URLSearchParams(location.search).get("sala");
  const saved = JSON.parse(sessionStorage.getItem("cc-room") || "null");
  if (saved && (!codeFromUrl || saved.code === codeFromUrl)) {
    // Recarregou a página: volta para a sala (e recupera o papel de host se for o caso).
    state.wantRoom = saved;
    $("name").value = saved.name;
    connect();
  } else if (codeFromUrl) {
    $("code").value = codeFromUrl.toUpperCase();
    (state.name ? $("join") : $("name")).focus();
  }
})();
