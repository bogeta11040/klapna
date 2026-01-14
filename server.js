// server.js
const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 3000;

// Crockford-ish Base32 bez 0/O/1/I (32 chars)
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32
const ROOM_LEN = 6;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6; // 6h

/** roomId like ABC-DEF */
function generateRoomId() {
  let s = "";
  for (let i = 0; i < ROOM_LEN; i++) {
    const idx = Math.floor(Math.random() * ROOM_ALPHABET.length);
    s += ROOM_ALPHABET[idx];
  }
  return s.slice(0, 3) + "-" + s.slice(3);
}

function nowMs() {
  return Date.now();
}

// In-memory state
const rooms = new Map(); // roomId -> { createdAt, masterId, clients: Map(clientId -> ws) }

function cleanupRooms() {
  const t = nowMs();
  for (const [roomId, room] of rooms.entries()) {
    if (t - room.createdAt > ROOM_TTL_MS || room.clients.size === 0) {
      rooms.delete(roomId);
    }
  }
}

// HTTP server just for health check
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
    return;
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("sync-backend");
});

const wss = new WebSocket.Server({ server });

function send(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Basic heartbeat to keep connections alive
function heartbeat() {
  this.isAlive = true;
}

wss.on("connection", (ws) => {
  ws.isAlive = true;
  ws.on("pong", heartbeat);

  // Track which room/client this socket belongs to
  ws._roomId = null;
  ws._clientId = null;
  ws._isMaster = false;

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      send(ws, { type: "ERROR", code: "BAD_JSON" });
      return;
    }

    const type = msg.type;

    // 1) CREATE_ROOM
    if (type === "CREATE_ROOM") {
      // Create new room with unique ID
      let roomId;
      for (let i = 0; i < 10; i++) {
        roomId = generateRoomId();
        if (!rooms.has(roomId)) break;
        roomId = null;
      }
      if (!roomId) {
        send(ws, { type: "ERROR", code: "ROOM_ID_EXHAUSTED" });
        return;
      }

      const masterId = msg.masterId || ("master-" + Math.random().toString(16).slice(2));
      const room = { createdAt: nowMs(), masterId, clients: new Map() };
      rooms.set(roomId, room);

      // auto-join master
      room.clients.set(masterId, ws);
      ws._roomId = roomId;
      ws._clientId = masterId;
      ws._isMaster = true;

      send(ws, { type: "ROOM_CREATED", roomId, masterId, tsServerMs: nowMs() });
      return;
    }

    // 2) JOIN_ROOM
    if (type === "JOIN_ROOM") {
      const roomId = msg.roomId;
      const clientId = msg.clientId;

      if (!roomId || !clientId) {
        send(ws, { type: "ERROR", code: "MISSING_FIELDS" });
        return;
      }
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { type: "ERROR", code: "ROOM_NOT_FOUND" });
        return;
      }
      if (room.clients.has(clientId)) {
        send(ws, { type: "ERROR", code: "CLIENT_ID_TAKEN" });
        return;
      }

      room.clients.set(clientId, ws);
      ws._roomId = roomId;
      ws._clientId = clientId;
      ws._isMaster = false;

      send(ws, { type: "JOINED", roomId, clientId, tsServerMs: nowMs() });

      // notify master (optional)
      const masterWs = room.clients.get(room.masterId);
      if (masterWs) send(masterWs, { type: "CLIENT_JOINED", roomId, clientId });

      return;
    }

    // From here on we require the socket to be in a room
    const roomId = ws._roomId;
    const clientId = ws._clientId;
    if (!roomId || !clientId) {
      send(ws, { type: "ERROR", code: "NOT_IN_ROOM" });
      return;
    }
    const room = rooms.get(roomId);
    if (!room) {
      send(ws, { type: "ERROR", code: "ROOM_GONE" });
      return;
    }

    // 3) SYNC_PING -> SYNC_PONG (server time authority)
    if (type === "SYNC_PING") {
      // echo seq + t0 back, add tsServerMs
      send(ws, {
        type: "SYNC_PONG",
        seq: msg.seq ?? null,
        t0: msg.t0 ?? null,
        tsServerMs: nowMs(),
      });
      return;
    }

    // 4) START_AT broadcast (master only)
    if (type === "START_AT") {
      if (!ws._isMaster) {
        send(ws, { type: "ERROR", code: "NOT_MASTER" });
        return;
      }
      const tsServerMs = msg.tsServerMs;
      if (typeof tsServerMs !== "number") {
        send(ws, { type: "ERROR", code: "BAD_TIMESTAMP" });
        return;
      }

      // broadcast to all in room
      for (const [cid, clientWs] of room.clients.entries()) {
        send(clientWs, { type: "START_AT", roomId, tsServerMs });
      }
      return;
    }

    // Optional: ACK_START pass to master
    if (type === "ACK_START") {
      const masterWs = room.clients.get(room.masterId);
      if (masterWs) {
        send(masterWs, { type: "ACK_START", from: clientId, payload: msg.payload ?? {} });
      }
      return;
    }

    send(ws, { type: "ERROR", code: "UNKNOWN_TYPE" });
  });

  ws.on("close", () => {
    const roomId = ws._roomId;
    const clientId = ws._clientId;
    if (!roomId || !clientId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.clients.delete(clientId);

    // if master left, close room (simple policy)
    if (ws._isMaster) {
      // notify others then drop
      for (const [, clientWs] of room.clients.entries()) {
        send(clientWs, { type: "ROOM_CLOSED", roomId });
        try { clientWs.close(); } catch {}
      }
      rooms.delete(roomId);
    } else {
      // notify master
      const masterWs = room.clients.get(room.masterId);
      if (masterWs) send(masterWs, { type: "CLIENT_LEFT", roomId, clientId });
    }
  });
});

// Heartbeat interval
const interval = setInterval(() => {
  cleanupRooms();
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 15000);

wss.on("close", () => clearInterval(interval));

server.listen(PORT, () => {
  console.log(`Listening on :${PORT}`);
});