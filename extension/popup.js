// Popup da extensão: criar/entrar/sair da sala. Todo o estado vive no background.js.
const $ = (id) => document.getElementById(id);
let snapshot = null;

async function send(message) {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    return { error: String(err) };
  }
}

function render(s) {
  snapshot = s;
  if (!s) return;
  $("dot").className = `dot ${s.status}`;
  $("status").textContent =
    { connected: "Conectado ao servidor", connecting: "Conectando…", disconnected: s.room ? "Desconectado — tentando reconectar" : "Fora de uma sala" }[s.status] || s.status;
  $("error").hidden = !s.lastError;
  $("error").textContent = s.lastError || "";
  if (document.activeElement !== $("name") && !$("name").value) $("name").value = s.name || "";
  if (document.activeElement !== $("server")) $("server").value = s.serverUrl || "";

  const inRoom = Boolean(s.room);
  $("out").hidden = inRoom;
  $("in").hidden = !inRoom;
  if (!inRoom) return;

  $("roomcode").textContent = s.room.code;
  const hostName = s.room.participants.find((p) => p.id === s.room.hostId)?.name || "?";
  $("role").innerHTML = s.isHost
    ? '<span class="host">★ Você é o host</span> — seu play/pause/seek sincroniza todo mundo.'
    : `Host: <b>${escapeHtml(hostName)}</b>. O vídeo segue o que o host faz.`;
  const people = $("people");
  people.textContent = "";
  for (const p of s.room.participants) {
    const el = document.createElement("span");
    el.className = "person" + (p.id === s.room.hostId ? " host" : "");
    el.textContent = p.name + (p.id === s.you?.id ? " (você)" : "");
    people.appendChild(el);
  }
  const url = s.room.state?.url;
  $("hosturl").hidden = !url || s.isHost;
  if (url) $("hostlink").href = url;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

$("create").addEventListener("click", async () => {
  const name = $("name").value.trim();
  if (!name) return $("name").focus();
  render(await send({ type: "create_room", name }));
});

$("join").addEventListener("click", async () => {
  const name = $("name").value.trim();
  const code = $("code").value.trim().toUpperCase();
  if (!name) return $("name").focus();
  if (code.length !== 6) return $("code").focus();
  const r = await send({ type: "join_room", name, code });
  if (r?.error) {
    $("error").hidden = false;
    $("error").textContent = r.error;
    return;
  }
  render(r);
});
$("code").addEventListener("keydown", (e) => {
  if (e.key === "Enter") $("join").click();
});

$("leave").addEventListener("click", async () => render(await send({ type: "leave_room" })));

$("copy").addEventListener("click", async () => {
  if (!snapshot?.room) return;
  await navigator.clipboard.writeText(snapshot.room.code).catch(() => {});
  $("copy").textContent = "Copiado!";
  setTimeout(() => ($("copy").textContent = "Copiar código"), 1500);
});

$("saveserver").addEventListener("click", async () => {
  const r = await send({ type: "set_server", url: $("server").value.trim() });
  if (r?.error) {
    $("error").hidden = false;
    $("error").textContent = r.error;
    return;
  }
  render(r);
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "state") render(msg.snapshot);
});

send({ type: "get_state" }).then(render);
