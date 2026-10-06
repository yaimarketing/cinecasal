// Site falso que responde como www.youtube.com (via --host-resolver-rules) com um <video>.
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const dir = path.join(path.dirname(new URL(import.meta.url).pathname), "site");
http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  if (u.pathname === "/clip.webm") {
    const file = path.join(dir, "clip.webm"); const stat = fs.statSync(file);
    const range = req.headers.range;
    if (range) {
      const [s, e] = range.replace("bytes=", "").split("-"); const start = +s; const end = e ? +e : stat.size - 1;
      res.writeHead(206, { "content-type": "video/webm", "content-range": `bytes ${start}-${end}/${stat.size}`, "accept-ranges": "bytes", "content-length": end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": "video/webm", "content-length": stat.size, "accept-ranges": "bytes" });
    return fs.createReadStream(file).pipe(res);
  }
  if (u.pathname === "/watch") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(`<!doctype html><html><head><title>Fake YouTube ${u.searchParams.get("v")}</title></head><body style="background:#000;color:#fff">
      <h1 id="title">Vídeo ${u.searchParams.get("v")}</h1>
      <video class="html5-main-video" src="/clip.webm" controls preload="auto" style="width:320px"></video>
    </body></html>`);
  }
  if (u.pathname === "/login") { res.writeHead(200, { "content-type": "text/html" }); return res.end("<h1>login</h1>"); }
  res.writeHead(200, { "content-type": "text/html" }); res.end("<h1>home</h1>");
}).listen(80, () => console.log("fake site on :80"));
