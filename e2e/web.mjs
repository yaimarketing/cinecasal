// Teste ponta a ponta do MODO WEB: host no desktop e convidado num viewport de celular.
// O próprio teste sobe (e reinicia) o servidor em :8080. Pré-requisito: fake-site.mjs na porta 80 (serve /clip.webm).
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";
const TMP = path.dirname(new URL(import.meta.url).pathname);
let server;
async function startServer() {
  try {
    await fetch("http://localhost:8080/health");
    throw new Error("já existe algo na porta 8080: encerre antes de rodar o teste");
  } catch (err) {
    if (!(err.cause || err.code === undefined && /fetch failed/.test(err.message))) throw err;
  }
  server = spawn(process.execPath, [path.join(TMP, "..", "server", "server.js")], { stdio: "inherit", env: { ...process.env, PORT: "8080" } });
  let dead = false;
  server.once("exit", () => (dead = true));
  for (let i = 0; i < 50; i++) {
    if (dead) throw new Error("o servidor do teste morreu ao iniciar");
    try {
      if ((await fetch("http://localhost:8080/health")).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("servidor não subiu");
}
await startServer();
const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log(`${ok ? "✔" : "✘"} ${name}${info ? " — " + info : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"], ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}) });
const host = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })).newPage();
const vstate = (p) => p.evaluate(() => { const v = document.getElementById("video"); return { paused: v.paused, t: v.currentTime }; });
const chatText = (p) => p.evaluate(() => document.getElementById("messages").innerText);
try {
  await host.goto("http://localhost:8080/");
  await host.fill("#name", "Ana");
  await host.click("#create");
  await host.waitForSelector("#view-room:not([hidden])");
  const code = (await host.textContent("#roomcode")).trim();
  check("host criou a sala", /^[A-Z0-9]{6}$/.test(code), code);
  check("URL da sala virou /s/CODIGO", host.url().endsWith(`/s/${code}`), host.url());

  // Convidado entra pelo link da sala, no celular
  await guest.goto(`http://localhost:8080/s/${code}`);
  check("link da sala preenche o código", (await guest.inputValue("#code")) === code);
  await guest.fill("#name", "Bia");
  await guest.click("#join");
  await guest.waitForSelector("#view-room:not([hidden])");
  await sleep(500);
  check("casal aparece nos dois lados", (await host.textContent("#couple")).includes("Bia") && (await guest.textContent("#couple")).includes("Ana"));
  check("convidado não vê a barra do host", await guest.isHidden("#host-bar"));
  const noScroll = await guest.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  check("celular sem rolagem horizontal", noScroll);

  // Host escolhe um vídeo direto (mesmo caminho do Google Drive: <video>)
  await host.fill("#video-url", "http://127.0.0.1/clip.webm");
  await host.click("#host-bar button[type=submit]");
  await guest.waitForSelector("#player-video:not([hidden])", { timeout: 10000 });
  await sleep(800);
  await host.evaluate(() => { const v = document.getElementById("video"); v.currentTime = 20; return v.play(); });
  await sleep(1500);
  let g = await vstate(guest), h = await host.evaluate(() => document.getElementById("video").currentTime);
  check("host deu play em 20s → convidado toca alinhado", !g.paused && Math.abs(g.t - h) < 1.5, `host=${h.toFixed(1)} guest=${g.t.toFixed(1)}`);
  await host.evaluate(() => { document.getElementById("video").currentTime = 60; });
  await sleep(1500);
  g = await vstate(guest);
  check("host pulou para 60s → convidado acompanha", Math.abs(g.t - 60) < 3, `guest=${g.t.toFixed(1)}`);
  await host.evaluate(() => document.getElementById("video").pause());
  await sleep(1000);
  g = await vstate(guest);
  check("host pausou → convidado pausa", g.paused);
  check("convidado não tem controles no vídeo", await guest.evaluate(() => !document.getElementById("video").controls));

  // Chat e reação
  await guest.fill("#text", "tô vendo!! 💕");
  await guest.press("#text", "Enter");
  await sleep(500);
  check("chat chega no host", (await chatText(host)).includes("tô vendo!! 💕"));
  await host.click('.reaction-bar button[data-emoji="❤️"]');
  await sleep(300);
  check("reação flutua no convidado", await guest.evaluate(() => document.querySelectorAll("#reactions-layer span").length > 0));
  const sys = await chatText(guest);
  check("eventos de sistema", /Host deu play/.test(sys) && /Host pulou/.test(sys) && /Host pausou/.test(sys), sys.replace(/\n+/g, " | ").slice(0, 200));

  await host.screenshot({ path: path.join(TMP, "web-host.png") });
  await guest.screenshot({ path: path.join(TMP, "web-guest-mobile.png") });

  // Modo relógio (Netflix)
  await host.fill("#video-url", "https://www.netflix.com/watch/80100172");
  await host.click("#host-bar button[type=submit]");
  await guest.waitForSelector("#player-manual:not([hidden])", { timeout: 10000 });
  check("link da Netflix vira modo relógio", (await guest.textContent("#manual-service")).includes("Netflix"));
  await host.fill("#m-time", "1:30:00");
  await host.click("#m-set");
  await host.click("#m-countdown");
  await sleep(600);
  check("contagem aparece no convidado", await guest.isVisible("#countdown"));
  await sleep(3500);
  const clock = await guest.textContent("#clock");
  check("relógio do convidado toca a partir de 1:30:00", /^1:30:0[0-9]$/.test(clock.trim()) && (await guest.textContent("#clock-state")).includes("Tocando"), clock);
  await guest.screenshot({ path: path.join(TMP, "web-guest-clock.png") });

  // Recarregar a página do host: volta para a sala e continua host
  await host.reload();
  await host.waitForSelector("#view-room:not([hidden])", { timeout: 10000 });
  await sleep(800);
  check("host recarregou e continua host", await host.isVisible("#host-bar"));
  check("convidado viu o host voltar", /Ana agora é o host|Ana entrou/.test(await chatText(guest)));

  // Servidor reinicia (como no Render): a sala volta com o mesmo código e estado, sem ninguém fazer nada.
  const before = await guest.textContent("#clock");
  const exited = new Promise((r) => server.once("exit", r));
  server.kill("SIGKILL");
  await exited;
  await host.waitForFunction(() => !document.getElementById("dot").classList.contains("connected"), null, { timeout: 10000 });
  check("os dois perceberam a queda do servidor", await guest.evaluate(() => !document.getElementById("dot").classList.contains("connected")));
  await startServer();
  await host.waitForFunction(() => document.getElementById("dot").classList.contains("connected"), null, { timeout: 20000 });
  await guest.waitForFunction(() => document.getElementById("dot").classList.contains("connected"), null, { timeout: 20000 });
  await sleep(1000);
  check("após reinício, os dois continuam na mesma sala", (await host.textContent("#roomcode")).trim() === code && (await guest.textContent("#roomcode")).trim() === code && (await guest.textContent("#couple")).includes("Ana"));
  check("após reinício, host continua host", (await host.isVisible("#host-bar")) && (await guest.isHidden("#host-bar")));
  const after = await guest.textContent("#clock");
  check("após reinício, relógio continua de onde estava", /^1:30:/.test(after.trim()) && (await guest.textContent("#clock-state")).includes("Tocando"), `${before.trim()} → ${after.trim()}`);
  check("chat avisou a reconexão", /Reconectado/.test(await chatText(guest)), (await chatText(guest)).replace(/\n+/g, " | ").slice(-300));
} catch (err) {
  check("execução sem exceção", false, String(err.stack || err));
} finally {
  await browser.close();
  server?.kill();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} verificações passaram`);
process.exit(failed ? 1 : 0);
