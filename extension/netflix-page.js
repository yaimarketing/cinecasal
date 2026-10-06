// Roda no mundo da PÁGINA (world: MAIN) só na Netflix.
//
// Por quê: o player da Netflix (Cadmium) ignora ou trava quando se mexe em
// video.currentTime por fora. A API interna dele, acessível em
// window.netflix.appContext, faz seek/play/pause direitinho. O content.js
// (mundo isolado) não enxerga window.netflix, então pede por postMessage.
// Esses caminhos internos mudam sem aviso; se quebrarem, o content.js cai no
// fallback (clique no botão / tecla espaço) porque não recebe "ok".
(() => {
  if (window.__watchpartyNetflixBridge) return;
  window.__watchpartyNetflixBridge = true;

  function getPlayer() {
    try {
      const api = window.netflix?.appContext?.state?.playerApp?.getAPI?.();
      const vp = api?.videoPlayer;
      const ids = vp?.getAllPlayerSessionIds?.() || [];
      // Em geral há uma sessão "watch-..." (o filme) e às vezes "motion-billboard" (prévia).
      const id = ids.find((i) => String(i).startsWith("watch")) || ids[0];
      return id ? vp.getVideoPlayerBySessionId(id) : null;
    } catch {
      return null;
    }
  }

  window.addEventListener("message", (ev) => {
    if (ev.source !== window || ev.data?.source !== "watchparty-netflix") return;
    const { id, action, time } = ev.data;
    let ok = false;
    try {
      const player = getPlayer();
      if (player) {
        if (action === "seek") {
          player.seek(Math.max(0, Math.round(time * 1000))); // milissegundos
          ok = true;
        } else if (action === "play") {
          player.play();
          ok = true;
        } else if (action === "pause") {
          player.pause();
          ok = true;
        }
      }
    } catch {
      ok = false;
    }
    window.postMessage({ source: "watchparty-netflix-reply", id, ok }, location.origin);
  });
})();
