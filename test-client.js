const WebSocket = require("ws");

const URL = process.env.URL || "ws://127.0.0.1:3000/ws";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function mk(name) {
  const ws = new WebSocket(URL);
  const messages = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    messages.push(m);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].pred(m)) {
        const w = waiters.splice(i, 1)[0];
        w.resolve(m);
      }
    }
  });
  const open = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });
  return {
    name,
    ws,
    open,
    messages,
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor(pred, ms = 5000) {
      const found = messages.find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve };
        waiters.push(w);
        setTimeout(() => {
          const i = waiters.indexOf(w);
          if (i >= 0) {
            waiters.splice(i, 1);
            reject(new Error(`${name}: timeout esperando mensaje`));
          }
        }, ms);
      });
    },
    close: () => ws.close(),
  };
}

async function hello(c, name) {
  c.send({ t: "hello", name });
  return c.waitFor((m) => m.t === "hello");
}

async function testCoop() {
  const a = mk("A");
  const b = mk("B");
  await Promise.all([a.open, b.open]);
  const ah = await hello(a, "Alfonso");
  const bh = await hello(b, "Amigo");
  a.send({ t: "create", mode: "coop", max: 8 });
  const room = await a.waitFor((m) => m.t === "room" && m.code);
  b.send({ t: "join", code: room.code });
  await b.waitFor((m) => m.t === "room" && m.players.length === 2);
  a.send({ t: "start" });
  await a.waitFor((m) => m.t === "start");
  a.send({ t: "pos", x: 0, y: 0, z: 0, ry: 0 });
  b.send({ t: "pos", x: 1, y: 0, z: 1, ry: 0 });
  a.send({ t: "aipos", x: 1, y: 0, z: 1 });
  await sleep(200);
  a.send({ t: "kill", target: bh.id, ai: true });
  await b.waitFor((m) => m.t === "event" && m.kind === "kill");
  const end = await b.waitFor((m) => m.t === "end");
  if (end.winner !== "baldi") throw new Error("coop: ganador incorrecto");
  a.close();
  b.close();
  console.log("COOP OK (id " + ah.id + ", sala " + room.code + ")");
}

async function testFree() {
  const c = mk("C");
  const d = mk("D");
  await Promise.all([c.open, d.open]);
  await hello(c, "BaldiHumano");
  const dh = await hello(d, "Estudiante");
  c.send({ t: "create", mode: "free", max: 8 });
  const room = await c.waitFor((m) => m.t === "room" && m.code);
  d.send({ t: "join", code: room.code });
  await d.waitFor((m) => m.t === "room" && m.players.length === 2);
  c.send({ t: "role", role: "baldi" });
  await c.waitFor((m) => m.t === "room" && m.players.some((p) => p.role === "baldi"));
  c.send({ t: "start" });
  const start = await c.waitFor((m) => m.t === "start");
  const roles = start.players.map((p) => p.role).sort();
  if (roles.join(",") !== "baldi,survivor") throw new Error("free: roles incorrectos " + roles);
  c.send({ t: "pos", x: 0, y: 0, z: 0, ry: 0 });
  d.send({ t: "pos", x: 1, y: 0, z: 1, ry: 0 });
  await sleep(150);
  c.send({ t: "kill", target: dh.id });
  const end = await c.waitFor((m) => m.t === "end");
  if (end.winner !== "baldi") throw new Error("free: ganador incorrecto");
  c.close();
  d.close();
  console.log("FREE OK (sala " + room.code + ")");
}

async function testChaos() {
  const e = mk("E");
  const f = mk("F");
  await Promise.all([e.open, f.open]);
  await hello(e, "Uno");
  await hello(f, "Dos");
  e.send({ t: "create", mode: "chaos", max: 8 });
  const room = await e.waitFor((m) => m.t === "room" && m.code);
  f.send({ t: "join", code: room.code });
  await f.waitFor((m) => m.t === "room" && m.players.length === 2);
  e.send({ t: "start" });
  const start = await e.waitFor((m) => m.t === "start");
  const survivors = start.players.filter((p) => p.role === "survivor");
  const baldis = start.players.filter((p) => p.role === "baldi");
  if (survivors.length !== 1 || baldis.length !== 1) {
    throw new Error("chaos: roles incorrectos");
  }
  e.close();
  f.close();
  console.log("CHAOS OK (sala " + room.code + ")");
}

async function testEscape() {
  const g = mk("G");
  const h = mk("H");
  await Promise.all([g.open, h.open]);
  await hello(g, "Escapista");
  const hh = await hello(h, "Ayudante");
  g.send({ t: "create", mode: "coop", max: 8 });
  const room = await g.waitFor((m) => m.t === "room" && m.code);
  h.send({ t: "join", code: room.code });
  await h.waitFor((m) => m.t === "room" && m.players.length === 2);
  g.send({ t: "start" });
  await g.waitFor((m) => m.t === "start");
  for (let i = 0; i < 7; i++) {
    h.send({ t: "notebook" });
  }
  const last = await h.waitFor(
    (m) => m.t === "event" && m.kind === "notebook" && m.count === 7
  );
  await g.waitFor((m) => m.t === "event" && m.kind === "notebook" && m.count === 7);
  if (last.by !== hh.id) throw new Error("escape: cuaderno de otro jugador");
  h.send({ t: "win" });
  const end = await h.waitFor((m) => m.t === "end");
  if (end.winner !== "survivors") throw new Error("escape: ganador incorrecto");
  if (!/escap/i.test(end.reason)) throw new Error("escape: motivo incorrecto");
  g.close();
  h.close();
  console.log("ESCAPE OK (sala " + room.code + ")");
}

(async () => {
  try {
    await testCoop();
    await testFree();
    await testChaos();
    await testEscape();
    console.log("TODO OK");
    process.exit(0);
  } catch (err) {
    console.error("FALLO:", err.message);
    process.exit(1);
  }
})();
