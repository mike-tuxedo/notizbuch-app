/**
 * Notizbuch Relay Server (Plesk / Passenger)
 *
 * WebSocket Relay als Snapshot-Store für Offline-Sync.
 * Kein Static-File-Serving, kein TLS — Plesk/Apache macht beides.
 * Passenger setzt PORT automatisch.
 *
 * Message-Typen:
 *   join        — Room beitreten, sync-Response mit allen Nodes
 *   node-put    — Node speichern (Merge bei Objects, Replace bei Strings)
 *   node-get    — Einzelnen Node abrufen
 *   node-remove — Node löschen
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 7777;
const DATA_FILE = path.join(__dirname, 'data.json');
const SAVE_DELAY_MS = 2000;
const MAX_ROOM_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 Tage

// ─── Persistenz ─────────────────────────────────────────────────────────────

const rooms = new Map();
let saveTimer = null;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const now = Date.now();
      for (const [key, roomData] of Object.entries(raw)) {
        if (now - roomData.lastAccess > MAX_ROOM_AGE_MS) continue;
        rooms.set(key, {
          nodes: roomData.nodes || {},
          clients: new Set(),
          lastAccess: roomData.lastAccess
        });
      }
      console.log(`[Relay] ${rooms.size} Rooms geladen`);
    }
  } catch (e) {
    console.error('[Relay] Laden fehlgeschlagen:', e.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveSync();
  }, SAVE_DELAY_MS);
}

function saveSync() {
  const data = {};
  for (const [key, room] of rooms) {
    data[key] = { nodes: room.nodes, lastAccess: room.lastAccess };
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
  } catch (e) {
    console.error('[Relay] Speichern fehlgeschlagen:', e.message);
  }
}

loadData();

// Alte Rooms aufräumen (alle 6h)
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, room] of rooms) {
    if (now - room.lastAccess > MAX_ROOM_AGE_MS) {
      rooms.delete(key);
      changed = true;
    }
  }
  if (changed) scheduleSave();
}, 6 * 60 * 60 * 1000);

// ─── Room Management ────────────────────────────────────────────────────────

function getRoom(roomKey) {
  let room = rooms.get(roomKey);
  if (!room) {
    room = { nodes: {}, clients: new Set(), lastAccess: Date.now() };
    rooms.set(roomKey, room);
  }
  room.lastAccess = Date.now();
  return room;
}

function broadcastPeerCount(room) {
  const msg = JSON.stringify({ type: 'peers', count: room.clients.size });
  for (const c of room.clients) {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  }
}

// ─── HTTP + WebSocket Server ────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  // Health-Check
  if (req.url === '/health') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    });
    res.end(JSON.stringify({
      status: 'ok',
      rooms: rooms.size,
      clients: [...rooms.values()].reduce((n, r) => n + r.clients.size, 0)
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Notizbuch Relay — connect via WebSocket');
});

const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
  let currentRoom = null;
  let currentRoomKey = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        if (currentRoom) {
          currentRoom.clients.delete(ws);
          broadcastPeerCount(currentRoom);
        }
        currentRoomKey = String(msg.room || '').slice(0, 128);
        if (!currentRoomKey) return;

        currentRoom = getRoom(currentRoomKey);
        currentRoom.clients.add(ws);

        ws.send(JSON.stringify({ type: 'sync', notebooks: currentRoom.nodes }));
        broadcastPeerCount(currentRoom);
        break;
      }

      case 'node-put': {
        if (!currentRoom || !msg.id || !msg.data) return;
        const key = String(msg.id);
        const existing = currentRoom.nodes[key];
        if (existing && typeof existing === 'object' && typeof msg.data === 'object') {
          currentRoom.nodes[key] = { ...existing, ...msg.data };
        } else {
          currentRoom.nodes[key] = msg.data;
        }
        scheduleSave();
        break;
      }

      case 'node-get': {
        if (!currentRoom || !msg.id) return;
        const nodeData = currentRoom.nodes[String(msg.id)] || null;
        ws.send(JSON.stringify({ type: 'node-data', id: msg.id, data: nodeData }));
        break;
      }

      case 'node-remove': {
        if (!currentRoom || !msg.id) return;
        delete currentRoom.nodes[String(msg.id)];
        scheduleSave();
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      currentRoom.clients.delete(ws);
      broadcastPeerCount(currentRoom);
    }
  });

  ws.on('error', () => {
    if (currentRoom) currentRoom.clients.delete(ws);
  });
});

server.listen(PORT, () => {
  console.log(`[Relay] Server läuft auf Port ${PORT}`);
});

process.on('SIGINT', () => { saveSync(); process.exit(0); });
process.on('SIGTERM', () => { saveSync(); process.exit(0); });
