/*
 * Baldi Online - relay WebSocket
 * Rooms, roles and timer live here; clients only send positions and events.
 */
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;
const TICK_MS = 100;
const MODES = new Set(["coop", "free", "chaos", "hypersoda"]);
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

let nextPlayerId = 0;
const rooms = new Map();

function makeCode() {
  let code = "";
  for (let i = 0; i < 6; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return rooms.has(code) ? makeCode() : code;
}

function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(room, payload, exceptId) {
  for (const player of room.players.values()) {
    if (player.id !== exceptId) send(player.ws, payload);
  }
}

function roomInfo(room, viewerId) {
  return {
    t: "room",
    code: room.code,
    mode: room.mode,
    max: room.max,
    notebookTarget: room.notebookTarget,
    hyperStamina: room.hyperStamina,
    hyperCooldown: room.hyperCooldown,
    spooked: Boolean(room.spooked),
    state: room.state,
    hostId: room.hostId,
    you: viewerId,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      alive: p.alive,
      nb: p.notebooks || 0,
    })),
  };
}

function broadcastRoom(room) {
  for (const player of room.players.values()) {
    send(player.ws, roomInfo(room, player.id));
  }
}

function assignRoles(room) {
  const players = [...room.players.values()];
  players.forEach((p) => {
    p.notebooks = 0;
    p.alive = true;
  });

  if (room.mode === "coop" || room.mode === "hypersoda") {
    players.forEach((p) => {
      p.role = "survivor";
    });
    room.aiOwner = room.hostId;
  } else if (room.mode === "free") {
    // Los jugadores eligen rol en el lobby; nos aseguramos de que
    // al menos haya un Baldi y un superviviente.
    const hasBaldi = players.some((p) => p.role === "baldi");
    if (!hasBaldi && players.length > 0) {
      players[0].role = "baldi";
    }
    const hasSurvivor = players.some((p) => p.role === "survivor");
    if (!hasSurvivor && players.length > 1) {
      players[1].role = "survivor";
    }
    room.aiOwner = room.hostId;
  } else if (room.mode === "chaos") {
    // Un superviviente al azar, el resto son Baldi.
    const survivorIndex = Math.floor(Math.random() * players.length);
    players.forEach((p, i) => {
      p.role = i === survivorIndex ? "survivor" : "baldi";
    });
    room.aiOwner = room.hostId;
  } else {
    players.forEach((p) => {
      p.role = "survivor";
    });
    room.aiOwner = room.hostId;
  }
}

function startGame(room) {
  assignRoles(room);
  room.state = "playing";
  room.startedAt = Date.now() + 3000; // margen para que todos carguen la escuela
  room.duration = 0; // sin limite de tiempo: se gana escapando o se pierde al caer
  room.ai = null;
  room.winner = null;
  room.reason = null;
  room.notebooks = 0;

  const players = [...room.players.values()];
  const startPayload = {
    t: "start",
    mode: room.mode,
    duration: room.duration,
    notebookTarget: room.notebookTarget,
    hyperStamina: room.hyperStamina,
    hyperCooldown: room.hyperCooldown,
    now: Date.now(),
    aiOwner: room.aiOwner || null,
    players: players.map((p, index) => ({
      id: p.id,
      name: p.name,
      role: p.role,
      spawn: index,
      nb: p.notebooks || 0,
    })),
  };
  broadcast(room, startPayload);

  room.timer = setInterval(() => tick(room), TICK_MS);
}

function endGame(room, winner, reason) {
  if (room.state !== "playing") return;
  room.state = "ended";
  room.winner = winner;
  room.reason = reason;
  if (room.timer) {
    clearInterval(room.timer);
    room.timer = null;
  }
  broadcast(room, { t: "end", winner, reason });

  setTimeout(() => {
    if (room.state === "ended") {
      for (const player of room.players.values()) player.roomCode = null;
      rooms.delete(room.code);
    }
  }, 60000);
}

function survivorsAlive(room) {
  return [...room.players.values()].filter(
    (p) => p.role === "survivor" && p.alive
  );
}

function checkEnd(room) {
  if (room.state !== "playing") return;
  const alive = survivorsAlive(room);
  if (room.mode === "coop" || room.mode === "hypersoda") {
    if ([...room.players.values()].some((p) => !p.alive)) {
      endGame(room, "baldi", "Un jugador fue atrapado");
    }
    return;
  }
  if (alive.length === 0) {
    endGame(room, "baldi", "Todos los estudiantes cayeron");
  }
}

function tick(room) {
  if (room.state !== "playing") return;
  broadcast(room, {
    t: "snapshot",
    now: Date.now(),
    aiPos: room.ai,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      x: p.x || 0,
      y: p.y || 0,
      z: p.z || 0,
      ry: p.ry || 0,
      role: p.role,
      alive: p.alive,
      nb: p.notebooks || 0,
    })),
  });
}

function distance2d(a, b) {
  if (!a || !b) return 0;
  const dx = (a.x || 0) - (b.x || 0);
  const dz = (a.z || 0) - (b.z || 0);
  return Math.sqrt(dx * dx + dz * dz);
}

function handleLeave(client) {
  const room = rooms.get(client.roomCode);
  client.roomCode = null;
  if (!room) return;
  const player = room.players.get(client.id);
  if (!player) return;
  room.players.delete(client.id);

  if (room.players.size === 0) {
    if (room.timer) clearInterval(room.timer);
    rooms.delete(room.code);
    return;
  }

  if (room.hostId === client.id) {
    room.hostId = [...room.players.keys()][0];
    if (room.mode === "coop" || room.mode === "hypersoda") room.aiOwner = room.hostId;
    broadcast(room, { t: "host", id: room.hostId });
  }

  if (room.state === "playing") {
  if (room.players.size < 1) {
      endGame(room, "abandonada", "Un jugador salió");
      return;
    }
    checkEnd(room);
  }
  broadcastRoom(room);
}

function handleMessage(client, msg) {
  if (!msg || typeof msg.t !== "string") return;
  const room = rooms.get(client.roomCode);

  switch (msg.t) {
    case "hello": {
      client.name = String(msg.name || "Jugador").slice(0, 16);
      send(client.ws, { t: "hello", id: client.id, name: client.name });
      return;
    }
    case "create": {
      handleLeave(client);
      const mode = MODES.has(msg.mode) ? msg.mode : "coop";
      const max = Math.max(2, Math.min(8, Number(msg.max) || 8));
      const requestedBooks = Number(msg.notebookTarget);
      const notebookTarget = Number.isFinite(requestedBooks)
        ? Math.max(0, Math.min(7, Math.trunc(requestedBooks)))
        : 7;
      const hyperStamina = msg.hyperStamina === true;
      const requestedCooldown = Number(msg.hyperCooldown);
      const hyperCooldown = Number.isFinite(requestedCooldown)
        ? Math.max(0, Math.min(50, Math.trunc(requestedCooldown)))
        : 0;
      const code = makeCode();
      const newRoom = {
        code,
        mode,
        max,
        notebookTarget,
        hyperStamina,
        hyperCooldown,
        state: "lobby",
        hostId: client.id,
        players: new Map(),
        createdAt: Date.now(),
        timer: null,
        ai: null,
        aiOwner: null,
        spooked: false,
      };
      rooms.set(code, newRoom);
      const player = {
        id: client.id,
        name: client.name || "Jugador",
        role: "survivor",
        alive: true,
        notebooks: 0,
        ws: client.ws,
        x: 0,
        y: 0,
        z: 0,
        ry: 0,
      };
      newRoom.players.set(client.id, player);
      client.roomCode = code;
      broadcastRoom(newRoom);
      return;
    }
    case "join": {
      const code = String(msg.code || "").toUpperCase().trim();
      const joinRoom = rooms.get(code);
      if (!joinRoom) return send(client.ws, { t: "error", msg: "Sala no encontrada" });
      if (joinRoom.state !== "lobby")
        return send(client.ws, { t: "error", msg: "La partida ya empezó" });
      if (joinRoom.players.size >= joinRoom.max)
        return send(client.ws, { t: "error", msg: "Sala llena" });
      handleLeave(client);
      const player = {
        id: client.id,
        name: client.name || "Jugador",
        role: "survivor",
        alive: true,
        notebooks: 0,
        ws: client.ws,
        x: 0,
        y: 0,
        z: 0,
        ry: 0,
      };
      joinRoom.players.set(client.id, player);
      client.roomCode = code;
      broadcastRoom(joinRoom);
      return;
    }
    case "role": {
      if (!room || room.state !== "lobby" || room.mode !== "free") return;
      const player = room.players.get(client.id);
      if (!player) return;
      if (msg.role === "baldi" || msg.role === "survivor") {
        player.role = msg.role;
        broadcastRoom(room);
      }
      return;
    }
    case "settings": {
      if (!room || room.state !== "lobby") return;
      if (room.hostId !== client.id) return;
      if (typeof msg.hyperStamina === "boolean") {
        room.hyperStamina = msg.hyperStamina;
      }
      const requestedCooldown = Number(msg.hyperCooldown);
      if (Number.isFinite(requestedCooldown)) {
        room.hyperCooldown = Math.max(0, Math.min(50, Math.trunc(requestedCooldown)));
      }
      broadcastRoom(room);
      return;
    }
    case "start": {
      if (!room || room.state !== "lobby") return;
      if (room.hostId !== client.id) return;
      if (room.players.size < 1)
        return send(client.ws, { t: "error", msg: "Faltan jugadores" });
      startGame(room);
      return;
    }
    case "pos": {
      if (!room) return;
      const player = room.players.get(client.id);
      if (!player) return;
      player.x = Number(msg.x) || 0;
      player.y = Number(msg.y) || 0;
      player.z = Number(msg.z) || 0;
      player.ry = Number(msg.ry) || 0;
      return;
    }
    case "aipos": {
      if (!room || room.state !== "playing" || room.mode !== "coop" && room.mode !== "hypersoda") return;
      if (client.id !== room.hostId) return;
      room.ai = {
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
        ry: Number(msg.ry) || 0,
      };
      return;
    }
    case "noise": {
      if (!room || room.state !== "playing") return;
      const p = room.players.get(client.id);
      if (!p || !p.alive) return;
      const now = Date.now();
      if (client.lastNoise && now - client.lastNoise < 60) return;
      client.lastNoise = now;
      broadcast(room, {
        t: "event",
        kind: "noise",
        by: client.id,
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
        priority: Math.max(0, Math.min(8, Number(msg.priority) || 1)),
      });
      return;
    }
    case "angry": {
      if (!room || room.state !== "playing") return;
      const p = room.players.get(client.id);
      if (!p || !p.alive) return;
      const value = Number(msg.anger) || 0;
      if (value === 0) return;
      const now = Date.now();
      if (client.lastAngry && now - client.lastAngry < 150) return;
      client.lastAngry = now;
      broadcast(room, {
        t: "event",
        kind: "angry",
        by: client.id,
        anger: Math.max(-1, Math.min(1, value)),
        temp: Boolean(msg.temp),
      });
      return;
    }
    case "aggro": {
      if (!room || room.state !== "playing") return;
      const p = room.players.get(client.id);
      if (!p || !p.alive) return;
      broadcast(room, {
        t: "event",
        kind: "aggro",
        by: client.id,
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
        priority: Number(msg.priority) || 7,
      });
      return;
    }
    case "spook": {
      if (!room || room.state !== "playing") return;
      if (room.spooked) return;
      room.spooked = true;
      broadcast(room, { t: "event", kind: "spook" });
      broadcastRoom(room);
      return;
    }
    case "slap": {
      if (!room || room.state !== "playing" || room.mode !== "coop" && room.mode !== "hypersoda") return;
      broadcast(room, { t: "event", kind: "slap", by: client.id });
      return;
    }
    case "spray": {
      if (!room || room.state !== "playing") return;
      const thrower = room.players.get(client.id);
      if (!thrower || !thrower.alive) return;
      const sprayNow = Date.now();
      if (client.lastSprayAt && sprayNow - client.lastSprayAt < 200) return;
      client.lastSprayAt = sprayNow;
      broadcast(room, {
        t: "event",
        kind: "spray",
        by: client.id,
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
        rx: Number(msg.rx) || 0,
        ry: Number(msg.ry) || 0,
        rz: Number(msg.rz) || 0,
      });
      return;
    }
    case "kill": {
      if (!room || room.state !== "playing") return;
      const attacker = room.players.get(client.id);
      const target = room.players.get(String(msg.target || ""));
      if (!attacker || !target || !target.alive) return;
      const isAi = Boolean(msg.ai) && (room.mode === "coop" || room.mode === "hypersoda") && client.id === room.hostId;
      if (!isAi && attacker.role !== "baldi") return;
      if (target.role !== "survivor") return;
      if (isAi) {
        // El host manda su posicion actual; room.ai puede ir 100 ms atrasado.
        const aiPos = msg.hasPos ? { x: Number(msg.x) || 0, z: Number(msg.z) || 0 } : room.ai;
        if (aiPos && distance2d(aiPos, target) > 4.5) return;
      } else if (distance2d(attacker, target) > 5.5) return;
      target.alive = false;
      broadcast(room, {
        t: "event",
        kind: "kill",
        by: isAi ? "baldi-ai" : attacker.id,
        target: target.id,
      });
      checkEnd(room);
      return;
    }
    case "notebook": {
      if (!room || room.state !== "playing") return;
      const player = room.players.get(client.id);
      if (!player || player.role !== "survivor" || !player.alive) return;
      if ((room.notebooks || 0) >= 7) return;
      room.notebooks = Math.min(7, (room.notebooks || 0) + 1);
      broadcast(room, {
        t: "event",
        kind: "notebook",
        by: player.id,
        count: room.notebooks,
        x: Number(msg.x) || 0,
        y: Number(msg.y) || 0,
        z: Number(msg.z) || 0,
      });
      return;
    }
    case "win": {
      if (!room || room.state !== "playing") return;
      const player = room.players.get(client.id);
      if (!player || player.role !== "survivor" || !player.alive) return;
      const target = (room.notebookTarget != null) ? room.notebookTarget : 7;
      if (target > 0 && (room.notebooks || 0) < target) return;
      broadcast(room, { t: "event", kind: "escape", by: player.id });
      endGame(
        room,
        room.mode === "chaos" ? "survivor" : "survivors",
        player.name + " escapo con " + (target > 0 ? target + " cuadernos" : "infinitos cuadernos")
      );
      return;
    }
    case "chat": {
      if (!room) return;
      const text = String(msg.msg || "").slice(0, 200);
      if (!text) return;
      broadcast(room, {
        t: "chat",
        from: client.name || "Jugador",
        msg: text,
      });
      return;
    }
    case "leave": {
      handleLeave(client);
      send(client.ws, { t: "left" });
      return;
    }
    default:
      return;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Baldi Online relay activo");
});

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (ws) => {
  const client = {
    ws,
    id: "p" + ++nextPlayerId,
    name: "Jugador",
    roomCode: null,
  };
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  send(ws, { t: "welcome", id: client.id });
  ws.on("message", (data) => {
    try {
      handleMessage(client, JSON.parse(data.toString()));
    } catch (err) {
      console.error("mensaje inválido", err.message);
    }
  });
  ws.on("close", () => handleLeave(client));
  ws.on("error", () => handleLeave(client));
});

// keepalive
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Baldi Online relay en el puerto ${PORT}`);
});
