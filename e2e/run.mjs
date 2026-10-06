// Teste ponta a ponta: 2 perfis do Chromium com a extensão carregada e "www.youtube.com"
// apontando (via --host-resolver-rules) para o site falso local em fake-site.mjs.
// Pré-requisitos: servidor rodando em ws://localhost:8080, fake-site.mjs rodando na porta 80, ffmpeg no PATH.
// Uso: npm test   (veja package.json; no Linux sem tela use xvfb-run -a npm test)
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const EXT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "extension");
const TMP = path.dirname(new URL(import.meta.url).pathname);
const CLIP = path.join(TMP, "site", "clip.webm");
if (!fs.existsSync(CLIP)) {
  // Gera um clipe de teste de 2 minutos (barras coloridas + relógio) com o ffmpeg.
  execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc=duration=120:size=320x240:rate=10", "-f", "lavfi", "-i", "anullsrc=r=22050:cl=mono", "-t", "120", "-c:v", "libvpx", "-b:v", "200k", "-c:a", "libvorbis", CLIP]);
}
const results = [];
function check(name, ok, info = "") {
  results.push({ name, ok, info });
  console.log(`${ok ? "✔" : "✘"} ${name}${info ? " — " + info : ""}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function launch(profile) {
  const dir = path.join(TMP, "profiles", profile);
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: false,
    ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--host-resolver-rules=MAP www.youtube.com 127.0.0.1, MAP youtube.com 127.0.0.1",
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
    viewport: { width: 1100, height: 700 },
  });
  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent("serviceworker");
  const id = new URL(sw.url()).host;
  return { ctx, sw, id };
}

async function popup(b) {
  const p = await b.ctx.newPage();
  await p.goto(`chrome-extension://${b.id}/popup.html`);
  // A extensão vem apontando para o servidor público; o teste usa o servidor local.
  await p.evaluate(() => (document.querySelector("details").open = true));
  await p.fill("#server", "ws://localhost:8080");
  await p.click("#saveserver");
  await p.waitForFunction(() => document.getElementById("server").value === "ws://localhost:8080");
  return p;
}

async function sidebar(page) {
  return page.locator("#watchparty-root");
}

async function sidebarText(page) {
  return page.evaluate(() => document.querySelector("#watchparty-root")?.shadowRoot?.querySelector(".panel")?.innerText || "");
}

const A = await launch("host");
const B = await launch("guest");
try {
  // Host abre o vídeo
  const a = await A.ctx.newPage();
  await a.goto("http://www.youtube.com/watch?v=abc123xyz");
  await a.waitForSelector("video");

  // Host cria a sala pelo popup
  const pa = await popup(A);
  await pa.fill("#name", "Ana");
  await pa.click("#create");
  await pa.waitForSelector("#roomcode:not(:empty)", { timeout: 10000 });
  const code = (await pa.textContent("#roomcode")).trim();
  check("host criou a sala pelo popup", /^[A-Z0-9]{6}$/.test(code), code);
  check("popup indica que é o host", (await pa.textContent("#role")).includes("Você é o host"));

  // Host define um estado antes de alguém entrar (toca e pausa em 20s)
  await a.evaluate(() => { const v = document.querySelector("video"); v.currentTime = 20; return v.play(); });
  await sleep(600);
  await a.evaluate(() => document.querySelector("video").pause());
  await sleep(600);

  // Convidado entra em OUTRO vídeo: deve ver o aviso de URL diferente
  const b = await B.ctx.newPage();
  await b.goto("http://www.youtube.com/watch?v=outro999");
  await b.waitForSelector("video");
  const pb = await popup(B);
  await pb.fill("#name", "Bia");
  await pb.fill("#code", code.toLowerCase());
  await pb.click("#join");
  await pb.waitForSelector("#roomcode:not(:empty)", { timeout: 10000 });
  check("convidado entrou pelo popup", (await pb.textContent("#roomcode")).trim() === code);
  check("popup do convidado mostra o host", (await pb.textContent("#role")).includes("Host:"));
  await sleep(800);
  const notice = await b.evaluate(() => { const n = document.querySelector("#watchparty-root")?.shadowRoot?.querySelector(".n-url"); return n && !n.hidden ? n.textContent : null; });
  check("aviso 'O host está assistindo…' em vídeo diferente", Boolean(notice), notice || "sem aviso");

  // Clica no aviso: navega para o vídeo do host
  await b.evaluate(() => document.querySelector("#watchparty-root").shadowRoot.querySelector(".n-url").click());
  await b.waitForURL(/abc123xyz/, { timeout: 10000 });
  await b.waitForSelector("video");
  await sleep(1500);
  let st = await b.evaluate(() => { const v = document.querySelector("video"); return { paused: v.paused, t: v.currentTime }; });
  check("ao abrir o vídeo do host, convidado recebe estado (pausado ~20s)", st.paused && Math.abs(st.t - 20) < 2, JSON.stringify(st));

  // Host dá play
  await a.evaluate(() => document.querySelector("video").play());
  await sleep(1500);
  st = await b.evaluate(() => { const v = document.querySelector("video"); return { paused: v.paused, t: v.currentTime }; });
  const ta = await a.evaluate(() => document.querySelector("video").currentTime);
  check("host deu play → convidado toca, tempo alinhado (<1.5s)", !st.paused && Math.abs(st.t - ta) < 1.5, `host=${ta.toFixed(1)} guest=${st.t.toFixed(1)}`);

  // Host pula para 60s
  await a.evaluate(() => { document.querySelector("video").currentTime = 60; });
  await sleep(1500);
  st = await b.evaluate(() => { const v = document.querySelector("video"); return { paused: v.paused, t: v.currentTime }; });
  check("host pulou para 60s → convidado acompanha", !st.paused && Math.abs(st.t - 60) < 3, `guest=${st.t.toFixed(1)}`);

  // Host pausa
  await a.evaluate(() => document.querySelector("video").pause());
  await sleep(1200);
  st = await b.evaluate(() => document.querySelector("video").paused);
  check("host pausou → convidado pausa", st === true);

  // Convidado NÃO controla: dar play nele não afeta o host
  await b.evaluate(() => document.querySelector("video").play());
  await sleep(1200);
  const hostPaused = await a.evaluate(() => document.querySelector("video").paused);
  check("play do convidado não muda o host", hostPaused === true);
  // (o convidado fica dessincronizado até o próximo sync do host; isso é esperado)
  await b.evaluate(() => document.querySelector("video").pause());

  // Chat: convidado escreve, host lê (barra lateral)
  await b.evaluate(() => {
    const r = document.querySelector("#watchparty-root").shadowRoot;
    r.querySelector(".compose input").value = "oi, chegou?";
    r.querySelector(".compose").requestSubmit();
  });
  await sleep(800);
  const hostSidebar = await sidebarText(a);
  check("mensagem de chat aparece na barra do host", hostSidebar.includes("Bia") && hostSidebar.includes("oi, chegou?"));
  check("eventos de sistema aparecem (entrou / play / pausou / pulou)", /Bia entrou/.test(hostSidebar) && /Host deu play/.test(hostSidebar) && /Host pausou/.test(hostSidebar) && /Host pulou/.test(hostSidebar), hostSidebar.replace(/\n+/g, " | ").slice(0, 300));
  const guestSidebar = await sidebarText(b);
  check("barra do convidado lista participantes e código", guestSidebar.includes(code) && guestSidebar.includes("Ana") && guestSidebar.includes("Bia (você)"));

  await a.screenshot({ path: path.join(TMP, "host.png") });
  await b.screenshot({ path: path.join(TMP, "guest.png") });
  await pa.screenshot({ path: path.join(TMP, "popup-host.png") });

  // Recolher a barra
  await b.evaluate(() => document.querySelector("#watchparty-root").shadowRoot.querySelector(".collapse").click());
  await sleep(300);
  const collapsed = await b.evaluate(() => { const r = document.querySelector("#watchparty-root").shadowRoot; return r.querySelector(".panel").classList.contains("collapsed") && !r.querySelector(".tab").hidden; });
  check("barra recolhe e mostra a aba lateral", collapsed);

  // Host sai → convidado vira host
  await pa.click("#leave");
  await sleep(1000);
  check("host saiu: popup volta para a tela inicial", await pa.isVisible("#create"));
  check("convidado virou host", (await pb.textContent("#role")).includes("Você é o host"));

  // Página de login mostra aviso
  const c = await B.ctx.newPage();
  await c.goto("http://www.youtube.com/login");
  await sleep(1200);
  const loginNotice = await c.evaluate(() => { const n = document.querySelector("#watchparty-root")?.shadowRoot?.querySelector(".n-login"); return n && !n.hidden ? n.textContent : null; });
  check("aviso de login em página de login", /Faça login/.test(loginNotice || ""), loginNotice || "sem aviso");
} catch (err) {
  check("execução sem exceção", false, String(err.stack || err));
} finally {
  await A.ctx.close().catch(() => {});
  await B.ctx.close().catch(() => {});
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} verificações passaram`);
process.exit(failed ? 1 : 0);
