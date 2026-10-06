// Content script do WatchParty: roda em youtube.com, netflix.com, primevideo.com e max.com
// (em todos os frames, pois alguns players ficam dentro de iframes).
//
// Responsabilidades:
//   - achar o <video> da página (MutationObserver: os players carregam dinamicamente);
//   - se você é o host: mandar "sync" ao dar play/pause/seek;
//   - se não é: aplicar os "sync" recebidos (ou avisar que o host está em outro vídeo);
//   - avisar quando a página pede login (sem <video> após 10s);
//   - barra lateral com participantes e chat (só no frame principal, em Shadow DOM).
//
// Particularidades por serviço estão comentadas em `controls` e `contentKey`.
(() => {
  if (window.__watchpartyLoaded) return;
  window.__watchpartyLoaded = true;

  const IS_TOP = window === window.top;
  const SERVICE = detectService(location.hostname);
  const SEEK_TOLERANCE = 1; // segundos
  const SYNC_DEBOUNCE_MS = 200;
  const DRIFT_SYNC_MS = 10_000; // host reenvia o estado periodicamente para corrigir desvios
  const LOGIN_WAIT_MS = 10_000;

  let snapshot = null; // último estado recebido do background
  let video = null;
  let ignoreLocalUntil = 0; // "applyingRemote": ignora eventos locais gerados por um sync aplicado
  let pendingSync = null; // sync recebido antes de o <video> existir
  let syncTimer = null;
  let lastHref = location.href;
  let loginTimer = null;

  function detectService(host) {
    if (host.includes("youtube.com")) return "youtube";
    if (host.includes("netflix.com")) return "netflix";
    if (host.includes("primevideo.com") || host.includes("amazon.")) return "prime";
    if (host.includes("max.com")) return "max";
    return "other";
  }

  const isHost = () => Boolean(snapshot?.isHost);
  const inRoom = () => Boolean(snapshot?.room);

  // ---------- Identificação do conteúdo pela URL ----------

  // Reduz a URL a uma "chave" do conteúdo, ignorando parâmetros de rastreamento, tempo (t=), região etc.
  function contentKey(url) {
    try {
      const u = new URL(url);
      const h = u.hostname;
      if (h.includes("youtube.com")) {
        const v = u.searchParams.get("v");
        const m = u.pathname.match(/^\/(shorts|live|embed)\/([^/?]+)/);
        return `yt:${v || m?.[2] || u.pathname}`;
      }
      if (h.includes("netflix.com")) {
        // /watch/80001234?trackId=... — o número é o id do título/episódio.
        const m = u.pathname.match(/\/watch\/(\d+)/);
        return `nf:${m?.[1] || u.pathname}`;
      }
      if (h.includes("primevideo.com") || h.includes("amazon.")) {
        // /detail/0ABCDEF/ref=... ou /region/eu/detail/... ou /gp/video/detail/ID (amazon.com).
        // Atenção: ao tocar um episódio o Prime costuma manter a URL da página da série.
        const m = u.pathname.match(/\/(detail|watch)\/([A-Za-z0-9]+)/);
        return `pv:${m?.[2] || u.pathname.replace(/\/ref=.*$/, "")}`;
      }
      if (h.includes("max.com")) {
        // /video/watch/<uuid>/<uuid>
        const m = u.pathname.match(/\/video\/watch\/([^/?]+)/);
        return `max:${m?.[1] || u.pathname}`;
      }
      return u.origin + u.pathname;
    } catch {
      return String(url);
    }
  }

  const sameContent = (a, b) => Boolean(a && b) && contentKey(a) === contentKey(b);

  function isWatchUrl(url) {
    const k = contentKey(url);
    if (SERVICE === "youtube") return /^yt:[A-Za-z0-9_-]{6,}$/.test(k);
    if (SERVICE === "netflix") return /^nf:\d+$/.test(k);
    if (SERVICE === "prime") return /^pv:[A-Za-z0-9]+$/.test(k) && !k.includes("/");
    if (SERVICE === "max") return /^max:[^/]+$/.test(k) && k !== "max:/";
    return false;
  }

  function isLoginUrl(url) {
    return /\/(login|signin|sign-in|ap\/signin|auth|entrar)(\/|\?|$)/i.test(new URL(url).pathname);
  }

  function serviceLabel(url) {
    try {
      const h = new URL(url).hostname;
      if (h.includes("youtube")) return "um vídeo no YouTube";
      if (h.includes("netflix")) return "um título na Netflix";
      if (h.includes("primevideo") || h.includes("amazon")) return "um título no Prime Video";
      if (h.includes("max.com")) return "um título na Max";
      return h;
    } catch {
      return "outro vídeo";
    }
  }

  // ---------- Localizar o <video> ----------

  function findVideo() {
    let candidates = [];
    // Seletores preferenciais por serviço (todos têm fallback genérico).
    if (SERVICE === "youtube") candidates = [...document.querySelectorAll("video.html5-main-video")];
    if (SERVICE === "prime") candidates = [...document.querySelectorAll(".webPlayerElement video, .rendererContainer video")];
    if (SERVICE === "netflix") candidates = [...document.querySelectorAll(".watch-video video, [data-uia='video-canvas'] video")];
    if (!candidates.length) candidates = [...document.querySelectorAll("video")];
    if (!candidates.length) return null;
    // Prime e YouTube às vezes têm mais de um <video> (prévias, anúncios, "dummy").
    // Fica com o que tem mídia carregada e maior área na tela.
    const score = (v) => {
      const r = v.getBoundingClientRect();
      return (v.readyState > 0 ? 1e9 : 0) + (v.currentSrc ? 1e6 : 0) + r.width * r.height;
    };
    return candidates.sort((a, b) => score(b) - score(a))[0];
  }

  function attachVideo(v) {
    if (video === v) return;
    if (video) for (const ev of ["play", "pause", "seeked"]) video.removeEventListener(ev, onLocalEvent);
    video = v;
    if (!video) return;
    for (const ev of ["play", "pause", "seeked"]) video.addEventListener(ev, onLocalEvent);
    clearTimeout(loginTimer);
    hideNotice("login");
    if (pendingSync && !isHost()) {
      const s = pendingSync;
      pendingSync = null;
      applyRemoteSync(s);
    }
  }

  let checkScheduled = false;
  function scheduleCheck() {
    if (checkScheduled) return;
    checkScheduled = true;
    setTimeout(() => {
      checkScheduled = false;
      const v = findVideo();
      if (v !== video || (video && !video.isConnected)) attachVideo(v && v.isConnected ? v : null);
    }, 300);
  }

  const observer = new MutationObserver(scheduleCheck);
  observer.observe(document.documentElement, { childList: true, subtree: true });
  scheduleCheck();
  setInterval(scheduleCheck, 2000); // rede de segurança (players que trocam o <video> sem mutação visível)

  // ---------- Host: enviar sync ----------

  function onLocalEvent() {
    if (!isHost() || !video) return;
    if (Date.now() < ignoreLocalUntil) return; // evento causado por um sync que nós mesmos aplicamos
    clearTimeout(syncTimer);
    syncTimer = setTimeout(sendSync, SYNC_DEBOUNCE_MS);
  }

  function sendSync() {
    if (!isHost() || !video) return;
    chrome.runtime
      .sendMessage({
        type: "sync",
        paused: video.paused,
        currentTime: video.currentTime,
        url: IS_TOP ? location.href : null, // em iframe o background usa a URL da aba
      })
      .catch(() => {});
  }

  setInterval(() => {
    if (isHost() && video && !video.paused) sendSync();
  }, DRIFT_SYNC_MS);

  // ---------- Participante: aplicar sync ----------

  function applyRemoteSync(state) {
    if (isHost() || !state) return;
    if (IS_TOP && state.url && !sameContent(state.url, location.href)) {
      showNotice("url", `O host está assistindo ${serviceLabel(state.url)} — clique para abrir`, () => {
        chrome.runtime.sendMessage({ type: "system", text: "Você abriu o vídeo do host" }).catch(() => {});
        location.href = state.url;
      });
      return;
    }
    hideNotice("url");
    if (!video) {
      pendingSync = state;
      return;
    }
    // Se o host está tocando, compensa o tempo que a mensagem levou para chegar.
    const elapsed = state.paused ? 0 : Math.max(0, (Date.now() - (state.updatedAt || Date.now())) / 1000);
    const target = (Number(state.currentTime) || 0) + elapsed;

    ignoreLocalUntil = Date.now() + 1500;
    if (Math.abs(video.currentTime - target) > SEEK_TOLERANCE) controls.seek(target);
    if (state.paused && !video.paused) controls.pause();
    else if (!state.paused && video.paused) controls.play();
  }

  // ---------- Controles do player (com particularidades por serviço) ----------

  const controls = {
    play() {
      if (SERVICE === "netflix") return netflixCommand("play", null, () => domPlay());
      domPlay();
    },
    pause() {
      if (SERVICE === "netflix") return netflixCommand("pause", null, () => domPause());
      domPause();
    },
    seek(t) {
      // Netflix: mudar video.currentTime direto costuma ser ignorado ou travar o player;
      // o jeito confiável é a API interna do player (netflix-page.js, no mundo da página).
      if (SERVICE === "netflix") return netflixCommand("seek", t, () => { try { video.currentTime = t; } catch {} });
      // YouTube, Prime (.webPlayerElement) e Max (player Shaka) aceitam currentTime normalmente.
      try {
        video.currentTime = t;
      } catch {}
    },
  };

  function domPlay() {
    const p = video.play();
    if (p && typeof p.catch === "function") p.catch(() => fallbackToggle(true));
  }
  function domPause() {
    try {
      video.pause();
    } catch {
      fallbackToggle(false);
    }
    if (!video.paused) fallbackToggle(false);
  }

  // Fallback: simula o clique no botão de play/pause do player; se não achar, manda a tecla espaço
  // (atalho de play/pause em todos os quatro serviços).
  function fallbackToggle(wantPlay) {
    const selectors = {
      netflix: wantPlay ? "button[data-uia='control-play-pause-play']" : "button[data-uia='control-play-pause-pause']",
      youtube: ".ytp-play-button",
      prime: ".atvwebplayersdk-playpause-button, [aria-label='Reproduzir'], [aria-label='Play'], [aria-label='Pausar'], [aria-label='Pause']",
      max: "[data-testid='player-ux-play-pause-button'], [aria-label='Play'], [aria-label='Pause'], [aria-label='Reproduzir'], [aria-label='Pausar']",
    };
    // Os controles ficam escondidos até o mouse mexer.
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: 10, clientY: 10 }));
    const btn = document.querySelector(selectors[SERVICE] || "");
    if (btn) {
      btn.click();
      return;
    }
    const target = document.activeElement && document.activeElement !== document.body ? document.activeElement : document.body;
    for (const type of ["keydown", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, { key: " ", code: "Space", keyCode: 32, which: 32, bubbles: true }));
    }
  }

  // Ponte com netflix-page.js (mundo MAIN): pede a ação; se não houver resposta "ok", usa o fallback.
  let netflixSeq = 0;
  function netflixCommand(action, time, fallback) {
    const id = ++netflixSeq;
    let done = false;
    const onReply = (ev) => {
      if (ev.source !== window || ev.data?.source !== "watchparty-netflix-reply" || ev.data.id !== id) return;
      window.removeEventListener("message", onReply);
      done = true;
      if (!ev.data.ok) fallback();
    };
    window.addEventListener("message", onReply);
    window.postMessage({ source: "watchparty-netflix", id, action, time }, location.origin);
    setTimeout(() => {
      if (done) return;
      window.removeEventListener("message", onReply);
      fallback();
    }, 400);
  }

  // ---------- Aviso de login / paywall ----------

  function checkLogin() {
    clearTimeout(loginTimer);
    if (!IS_TOP || !inRoom()) return hideNotice("login");
    if (isLoginUrl(location.href)) return showNotice("login", "Faça login na sua conta para participar desta sala");
    if (!isWatchUrl(location.href) || video) return hideNotice("login");
    loginTimer = setTimeout(() => {
      if (!video && inRoom()) showNotice("login", "Faça login na sua conta para participar desta sala");
    }, LOGIN_WAIT_MS);
  }

  // ---------- Troca de URL (navegação SPA do YouTube/Netflix/Max) ----------

  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    if (isHost()) {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(sendSync, 500);
    } else if (snapshot?.room?.state) {
      applyRemoteSync(snapshot.room.state);
    }
    checkLogin();
  }, 1000);

  // ---------- Mensagens do background ----------

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "state") {
      const wasInRoom = inRoom();
      snapshot = msg.snapshot;
      renderSidebar();
      if (inRoom() !== wasInRoom) checkLogin();
      if (!inRoom()) {
        hideNotice("url");
        hideNotice("login");
      }
      return;
    }
    if (msg.type !== "server") return;
    const m = msg.message;
    if (m.type === "sync") applyRemoteSync(m);
    else if (m.type === "room_joined" && m.room?.state?.url && !isHost()) applyRemoteSync(m.room.state);
    else if (m.type === "host_changed" && isHost() && video) sendSync();
    else if (m.type === "participant_joined" && isHost()) sendSync(); // quem entrou recebe o estado fresco
    else if (m.type === "room_left") {
      hideNotice("url");
      hideNotice("login");
    }
  });

  chrome.runtime
    .sendMessage({ type: "get_state" })
    .then((s) => {
      if (!s || s.error) return;
      snapshot = s;
      renderSidebar();
      checkLogin();
      if (inRoom() && !isHost() && s.room.state?.url) applyRemoteSync(s.room.state);
    })
    .catch(() => {});

  // =====================================================================
  //  UI injetada (só no frame principal), em Shadow DOM para não brigar com o CSS do site
  // =====================================================================

  if (!IS_TOP) {
    // Frames internos só cuidam do <video>; as funções de UI viram no-ops.
    window.__watchpartyNoUI = true;
  }

  const ui = IS_TOP ? createUI() : null;
  function showNotice(kind, text, onClick) {
    ui?.showNotice(kind, text, onClick);
  }
  function hideNotice(kind) {
    ui?.hideNotice(kind);
  }
  function renderSidebar() {
    ui?.render(snapshot);
  }

  function createUI() {
    const host = document.createElement("div");
    host.id = "watchparty-root";
    host.style.cssText = "all:initial; position:fixed; z-index:2147483647; top:0; right:0;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
        .panel {
          position: fixed; top: 0; right: 0; height: 100vh; width: 320px; max-width: 90vw;
          background: #15131a; color: #ece9f1; display: flex; flex-direction: column;
          box-shadow: -4px 0 24px rgba(0,0,0,.5); font-size: 14px; line-height: 1.4;
          transition: transform .2s ease;
        }
        .panel.collapsed { transform: translateX(100%); }
        .head { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2c2834; }
        .head b { flex: 1; font-size: 14px; }
        .dot { width: 10px; height: 10px; border-radius: 50%; background: #888; flex: none; }
        .dot.connected { background: #4cc38a; } .dot.connecting { background: #f5b942; } .dot.disconnected { background: #ff6b6b; }
        .code { font-family: ui-monospace, monospace; letter-spacing: 1px; background: #2c2834; padding: 2px 6px; border-radius: 4px; cursor: pointer; }
        button { background: #2c2834; color: inherit; border: 0; border-radius: 6px; padding: 6px 10px; cursor: pointer; font-size: 13px; }
        button:hover { background: #3a3544; }
        .people { padding: 8px 12px; border-bottom: 1px solid #2c2834; display: flex; flex-wrap: wrap; gap: 6px; max-height: 96px; overflow: auto; }
        .person { background: #221f29; border-radius: 999px; padding: 2px 10px; font-size: 12px; }
        .person.host::before { content: "★ "; color: #f5b942; }
        .person.you { outline: 1px solid #6c5ce7; }
        .msgs { flex: 1; overflow-y: auto; padding: 10px 12px; display: flex; flex-direction: column; gap: 6px; }
        .msg .who { font-weight: 600; color: #a29bfe; margin-right: 6px; }
        .msg .when { color: #777; font-size: 11px; margin-left: 6px; }
        .msg .text { word-break: break-word; white-space: pre-wrap; }
        .msg.system { color: #8a8595; font-size: 12px; font-style: italic; }
        .msg.system .when { display: none; }
        .compose { display: flex; gap: 6px; padding: 10px 12px; border-top: 1px solid #2c2834; }
        .compose input { flex: 1; background: #221f29; border: 1px solid #3a3544; color: inherit; border-radius: 6px; padding: 8px; font-size: 14px; }
        .compose input:focus { outline: 2px solid #6c5ce7; }
        .tab {
          position: fixed; top: 50%; right: 0; transform: translateY(-50%);
          background: #6c5ce7; color: #fff; border-radius: 8px 0 0 8px; padding: 10px 8px; cursor: pointer;
          writing-mode: vertical-rl; text-orientation: mixed; font-size: 13px; font-weight: 600;
          box-shadow: -2px 0 10px rgba(0,0,0,.4); user-select: none;
        }
        .tab .badge { background: #ff6b6b; border-radius: 999px; padding: 0 6px; margin-top: 6px; writing-mode: horizontal-tb; display: inline-block; }
        .notice {
          position: fixed; top: 12px; left: 50%; transform: translateX(-50%);
          background: #6c5ce7; color: #fff; padding: 10px 16px; border-radius: 8px; font-size: 14px;
          box-shadow: 0 4px 16px rgba(0,0,0,.4); max-width: 80vw; text-align: center;
        }
        .notice.clickable { cursor: pointer; }
        .notice.clickable:hover { background: #5b4bd6; }
        .notice.warn { background: #b45309; }
        .panel:not(.collapsed) ~ .notice { left: calc(50% - 160px); }
        .err { color: #ff6b6b; font-size: 12px; padding: 4px 12px; }
      </style>
      <div class="panel collapsed" hidden>
        <div class="head">
          <span class="dot"></span>
          <b>WatchParty</b>
          <span class="code" title="Clique para copiar o código"></span>
          <button class="collapse" title="Recolher">›</button>
        </div>
        <div class="people"></div>
        <div class="err" hidden></div>
        <div class="msgs"></div>
        <form class="compose">
          <input type="text" maxlength="500" placeholder="Mensagem…" autocomplete="off" />
          <button type="submit">Enviar</button>
        </form>
      </div>
      <div class="tab" hidden>WatchParty <span class="badge" hidden></span></div>
      <div class="notice n-url clickable" hidden></div>
      <div class="notice n-login warn" hidden></div>
    `;
    (document.body || document.documentElement).appendChild(host);
    // Alguns sites limpam o <body>: garante que o painel volte.
    new MutationObserver(() => {
      if (!host.isConnected && document.body) document.body.appendChild(host);
    }).observe(document.documentElement, { childList: true });

    const $ = (sel) => root.querySelector(sel);
    const panel = $(".panel");
    const tab = $(".tab");
    const badge = $(".badge");
    const msgs = $(".msgs");
    const input = $(".compose input");
    let collapsed = sessionStorage.getItem("watchparty-collapsed") === "1";
    let unread = 0;
    let lastCount = 0;
    let renderedIds = new Set();

    function setCollapsed(v) {
      collapsed = v;
      sessionStorage.setItem("watchparty-collapsed", v ? "1" : "0");
      panel.classList.toggle("collapsed", v);
      tab.hidden = !v || !inRoom();
      if (!v) {
        unread = 0;
        badge.hidden = true;
        msgs.scrollTop = msgs.scrollHeight;
      }
    }
    $(".collapse").addEventListener("click", () => setCollapsed(true));
    tab.addEventListener("click", () => setCollapsed(false));
    $(".code").addEventListener("click", () => {
      const code = snapshot?.room?.code;
      if (code) navigator.clipboard?.writeText(code).catch(() => {});
    });
    $(".compose").addEventListener("submit", (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      input.value = "";
      chrome.runtime.sendMessage({ type: "chat", text }).catch(() => {});
    });
    // Não deixa as teclas do chat virarem atalhos do player (espaço = play/pause, etc.).
    for (const ev of ["keydown", "keyup", "keypress"]) input.addEventListener(ev, (e) => e.stopPropagation());

    function fmtClock(ts) {
      return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
    }

    function render(s) {
      if (!s || !s.room) {
        panel.hidden = true;
        tab.hidden = true;
        renderedIds = new Set();
        msgs.textContent = "";
        lastCount = 0;
        return;
      }
      panel.hidden = false;
      panel.classList.toggle("collapsed", collapsed);
      tab.hidden = !collapsed;
      $(".dot").className = `dot ${s.status}`;
      $(".dot").title = { connected: "Conectado", connecting: "Conectando…", disconnected: "Desconectado" }[s.status] || s.status;
      $(".code").textContent = s.room.code;
      const err = $(".err");
      err.hidden = !s.lastError;
      err.textContent = s.lastError || "";

      const people = $(".people");
      people.textContent = "";
      for (const p of s.room.participants) {
        const el = document.createElement("span");
        el.className = "person" + (p.id === s.room.hostId ? " host" : "") + (p.id === s.you?.id ? " you" : "");
        el.textContent = p.name + (p.id === s.you?.id ? " (você)" : "");
        el.title = p.id === s.room.hostId ? "Host" : "";
        people.appendChild(el);
      }

      const atBottom = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 40;
      let added = 0;
      for (const m of s.messages) {
        if (renderedIds.has(m.id)) continue;
        renderedIds.add(m.id);
        added++;
        const el = document.createElement("div");
        el.className = `msg ${m.kind}`;
        if (m.kind === "chat") {
          const who = document.createElement("span");
          who.className = "who";
          who.textContent = m.from?.name || "?";
          const text = document.createElement("span");
          text.className = "text";
          text.textContent = m.text;
          const when = document.createElement("span");
          when.className = "when";
          when.textContent = fmtClock(m.timestamp);
          el.append(who, text, when);
        } else {
          el.textContent = m.text;
        }
        msgs.appendChild(el);
      }
      if (added && (atBottom || lastCount === 0)) msgs.scrollTop = msgs.scrollHeight;
      if (added && collapsed && lastCount > 0) {
        unread += added;
        badge.textContent = String(unread);
        badge.hidden = false;
      }
      lastCount = s.messages.length;
    }

    function showNotice(kind, text, onClick) {
      const el = $(`.n-${kind}`);
      el.textContent = text;
      el.hidden = false;
      el.onclick = onClick || null;
    }
    function hideNotice(kind) {
      const el = $(`.n-${kind}`);
      el.hidden = true;
      el.onclick = null;
    }

    return { render, showNotice, hideNotice };
  }
})();
