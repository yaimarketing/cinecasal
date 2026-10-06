// Teste do protocolo: node --test (dentro de server/)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

process.env.PORT = process.env.PORT || "18080";
process.env.NODE_ENV = "test";
const { start, stop, rooms } = await import("./server.js");
const URL = `ws://localhost:${process.env.PORT}`;

function connect() {
  const ws = new WebSocket(URL);
  const queue = [];
  const waiters = [];
  ws.on("message", (data) => {
    const msg = JSON.parse(data.toString());
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  const next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
  const send = (m) => ws.send(JSON.stringify(m));
  return new Promise((resolve) => ws.once("open", () => resolve({ ws, next, send })));
}

before(() => start());
after(() => stop());

test("criar sala, entrar, sincronizar, chat, sair e troca de host", async () => {
  const a = await connect();
  const b = await connect();
  assert.equal((await a.next()).type, "hello");
  assert.equal((await b.next()).type, "hello");

  a.send({ type: "create_room", name: "  Ana  " });
  const created = await a.next();
  assert.equal(created.type, "room_created");
  assert.match(created.room.code, /^[A-Z2-9]{6}$/);
  assert.equal(created.room.hostId, created.you.id);
  assert.equal(created.you.name, "Ana");
  assert.deepEqual(created.room.state, { ...created.room.state, paused: true, currentTime: 0, url: null });

  // Host define o estado antes de alguém entrar.
  a.send({ type: "sync", paused: false, currentTime: 42.5, url: "https://www.youtube.com/watch?v=abc" });

  b.send({ type: "join_room", code: created.room.code.toLowerCase(), name: "Bia" });
  const joined = await b.next();
  assert.equal(joined.type, "room_joined");
  assert.equal(joined.room.state.url, "https://www.youtube.com/watch?v=abc");
  assert.equal(joined.room.state.currentTime, 42.5);
  assert.equal(joined.room.state.paused, false);
  assert.deepEqual(joined.room.participants.map((p) => p.name), ["Ana", "Bia"]);

  const pj = await a.next();
  assert.equal(pj.type, "participant_joined");
  assert.equal(pj.participant.name, "Bia");

  // Só o host sincroniza.
  b.send({ type: "sync", paused: true, currentTime: 1 });
  const err = await b.next();
  assert.equal(err.type, "error");
  assert.equal(err.code, "not_host");

  a.send({ type: "sync", paused: true, currentTime: 50, url: "https://www.youtube.com/watch?v=abc" });
  const sync = await b.next();
  assert.equal(sync.type, "sync");
  assert.equal(sync.paused, true);
  assert.equal(sync.currentTime, 50);
  assert.ok(typeof sync.updatedAt === "number");

  // Chat vai para todos, com nome e timestamp.
  b.send({ type: "chat", text: "oi!" });
  const [ca, cb] = await Promise.all([a.next(), b.next()]);
  for (const c of [ca, cb]) {
    assert.equal(c.type, "chat");
    assert.equal(c.from.name, "Bia");
    assert.equal(c.text, "oi!");
    assert.ok(typeof c.timestamp === "number");
  }

  // Host sai: Bia vira host.
  a.send({ type: "leave_room" });
  assert.equal((await a.next()).type, "room_left");
  const left = await b.next();
  assert.equal(left.type, "participant_left");
  assert.equal(left.participant.name, "Ana");
  const hc = await b.next();
  assert.equal(hc.type, "host_changed");
  assert.equal(hc.hostId, joined.you.id);

  // Agora Bia pode sincronizar; sala some quando esvazia.
  b.send({ type: "sync", paused: false, currentTime: 3 });
  b.send({ type: "ping" });
  assert.equal((await b.next()).type, "pong"); // garante que o sync já foi processado
  assert.equal(rooms.get(created.room.code).state.currentTime, 3);
  b.ws.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(rooms.has(created.room.code), false);
  a.ws.close();
});

test("sala inexistente e mensagens inválidas", async () => {
  const c = await connect();
  await c.next();
  c.send({ type: "join_room", code: "XXXXXX", name: "Zé" });
  assert.equal((await c.next()).code, "room_not_found");
  c.ws.send("isso não é json");
  assert.equal((await c.next()).code, "bad_json");
  c.send({ type: "chat", text: "sem sala" });
  assert.equal((await c.next()).code, "not_in_room");
  c.send({ type: "ping" });
  assert.equal((await c.next()).type, "pong");
  c.ws.close();
});
