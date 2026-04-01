/**
 * Notizbuch Dev-Server (HTTPS + WSS Relay + Debug Dashboard)
 *
 * Start:  node server.js
 *   LAN-IP wird automatisch erkannt.
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4444;
const PROJECT_DIR = path.resolve(__dirname, '..');
const MAX_ROOM_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) return cfg.address;
    }
  }
  return null;
}

// TLS
const certPath = path.join(PROJECT_DIR, 'cert.pem');
const keyPath = path.join(PROJECT_DIR, 'key.pem');

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error('Zertifikat nicht gefunden!');
  console.error('  mkcert -cert-file cert.pem -key-file key.pem localhost <LAN-IP>');
  process.exit(1);
}

const serverOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath)
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp',
  '.pem':  'application/x-pem-file'
};

// ─── Debug Event Log ───

const MAX_LOG = 200;
const eventLog = [];   // { ts, room, peer, peerName, type, detail }
const peers = new Map(); // peerId → { name, room, ws, connectedAt }

function logEvent(room, peerId, type, detail) {
  const peer = peers.get(peerId);
  const entry = {
    ts: Date.now(),
    room: room ? room.slice(0, 8) + '…' : '–',
    peer: peerId,
    peerName: peer?.name || peerId,
    type,
    detail: detail || ''
  };
  eventLog.push(entry);
  if (eventLog.length > MAX_LOG) eventLog.shift();
  // An alle Dashboard-Clients senden
  broadcastDashboard({ type: 'event', event: entry });
}

function getStatus() {
  const roomList = [];
  for (const [key, room] of rooms) {
    const clients = [];
    for (const ws of room.clients) {
      const p = [...peers.entries()].find(([, v]) => v.ws === ws);
      if (p) clients.push({ id: p[0], name: p[1].name, connectedAt: p[1].connectedAt });
    }
    roomList.push({
      room: key.slice(0, 8) + '…',
      nodes: Object.keys(room.nodes).length,
      clients
    });
  }
  return { rooms: roomList, totalPeers: peers.size, logSize: eventLog.length };
}

// Dashboard WebSocket clients
const dashboardClients = new Set();

function broadcastDashboard(msg) {
  const json = JSON.stringify(msg);
  for (const ws of dashboardClients) {
    if (ws.readyState === 1) ws.send(json);
  }
}

// ─── HTTPS Server ───

const httpsServer = https.createServer(serverOptions, (req, res) => {
  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // Debug API
  if (urlPath === '/api/debug') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ status: getStatus(), log: eventLog.slice(-50) }));
    return;
  }

  // LAN-IP API (für Share-Links)
  if (urlPath === '/api/lan-ip') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' });
    res.end(JSON.stringify({ ip: getLanIp() }));
    return;
  }

  const filePath = path.join(PROJECT_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PROJECT_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
});

// ─── Persistenz ───

const DATA_FILE = path.join(__dirname, 'data.json');
const SAVE_DELAY_MS = 2000;
let saveTimer = null;

function loadData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      const now = Date.now();
      for (const [key, roomData] of Object.entries(raw)) {
        if (now - roomData.lastAccess > MAX_ROOM_AGE_MS) continue;
        rooms.set(key, { nodes: roomData.nodes || roomData.notebooks || {}, clients: new Set(), lastAccess: roomData.lastAccess });
      }
      console.log(`[Persistenz] ${rooms.size} Rooms geladen aus data.json`);
    }
  } catch (e) {
    console.error('[Persistenz] Laden fehlgeschlagen:', e.message);
  }
}

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    const data = {};
    for (const [key, room] of rooms) {
      data[key] = { nodes: room.nodes, lastAccess: room.lastAccess };
    }
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
    } catch (e) {
      console.error('[Persistenz] Speichern fehlgeschlagen:', e.message);
    }
  }, SAVE_DELAY_MS);
}

// ─── WebSocket Relay ───

const rooms = new Map();
loadData();

setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [key, room] of rooms) {
    if (now - room.lastAccess > MAX_ROOM_AGE_MS) { rooms.delete(key); changed = true; }
  }
  if (changed) scheduleSave();
}, 6 * 60 * 60 * 1000);

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
    if (c.readyState === 1) c.send(msg);
  }
}

function broadcast(room, message, exclude) {
  const msg = typeof message === 'string' ? message : JSON.stringify(message);
  for (const c of room.clients) {
    if (c !== exclude && c.readyState === 1) c.send(msg);
  }
}

const wss = new WebSocketServer({ server: httpsServer });

wss.on('connection', (ws, req) => {
  let currentRoom = null;
  let currentRoomKey = null;
  const peerId = Math.random().toString(36).slice(2, 10);
  const clientIp = req.socket.remoteAddress;

  console.log(`[WS] Neue Verbindung: ${peerId} von ${clientIp} (${req.url})`);

  // Dashboard-Clients erkennen (via ?dashboard query param)
  if (req.url?.includes('dashboard=1')) {
    console.log(`[WS] Dashboard-Client: ${peerId}`);
    dashboardClients.add(ws);
    ws.send(JSON.stringify({ type: 'init', status: getStatus(), log: eventLog.slice(-50) }));
    ws.on('close', () => { dashboardClients.delete(ws); console.log(`[WS] Dashboard getrennt: ${peerId}`); });
    return;
  }

  peers.set(peerId, { name: peerId, room: null, ws, connectedAt: Date.now() });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        if (currentRoom) {
          currentRoom.clients.delete(ws);
          logEvent(currentRoomKey, peerId, 'leave', '');
          broadcastPeerCount(currentRoom);
        }
        currentRoomKey = String(msg.room || '').slice(0, 128);
        if (!currentRoomKey) return;

        // Client-Info speichern
        if (msg.name) {
          const p = peers.get(peerId);
          if (p) p.name = msg.name;
        }

        currentRoom = getRoom(currentRoomKey);
        currentRoom.clients.add(ws);
        const p = peers.get(peerId);
        if (p) p.room = currentRoomKey;

        const nodeCount = Object.keys(currentRoom.nodes).length;
        ws.send(JSON.stringify({ type: 'sync', notebooks: currentRoom.nodes }));
        logEvent(currentRoomKey, peerId, 'join', `${nodeCount} nodes im Room`);
        broadcastPeerCount(currentRoom);
        broadcastDashboard({ type: 'status', status: getStatus() });
        break;
      }

      // Legacy: altes Blob-Format (Abwärtskompatibilität)
      case 'put': {
        if (!currentRoom || !msg.id || !msg.data) return;
        currentRoom.nodes[String(msg.id)] = msg.data;
        logEvent(currentRoomKey, peerId, 'put', `node ${String(msg.id).slice(0,8)}…`);
        broadcast(currentRoom, { type: 'put', id: String(msg.id), data: msg.data, from: peerId }, ws);
        scheduleSave();
        break;
      }

      // Graph-Node Snapshot-Store: nur speichern, kein Broadcast (P2P macht Live-Sync)
      // Merge statt Replace: bestehende Felder (z.B. strokes) bleiben erhalten wenn nicht mitgesendet
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

      // Einzelnen Node abrufen (für Seiten-Strokes bei Navigation)
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

      case 'delete': {
        if (!currentRoom || !msg.id) return;
        delete currentRoom.nodes[String(msg.id)];
        logEvent(currentRoomKey, peerId, 'delete', `${String(msg.id).slice(0,8)}…`);
        broadcast(currentRoom, { type: 'delete', id: String(msg.id), from: peerId }, ws);
        scheduleSave();
        break;
      }
    }
  });

  ws.on('close', () => {
    if (currentRoom) {
      currentRoom.clients.delete(ws);
      logEvent(currentRoomKey, peerId, 'disconnect', '');
      broadcastPeerCount(currentRoom);
      broadcastDashboard({ type: 'status', status: getStatus() });
    }
    peers.delete(peerId);
  });

  ws.on('error', () => {
    if (currentRoom) currentRoom.clients.delete(ws);
    peers.delete(peerId);
  });
});

httpsServer.listen(PORT, '0.0.0.0', () => {
  const lanIp = getLanIp();
  console.log(`\n  Notizbuch Dev-Server läuft:`);
  console.log(`    App:       https://localhost:${PORT}/app.html`);
  if (lanIp) console.log(`    WLAN:      https://${lanIp}:${PORT}/app.html`);
  console.log(`    Daten:     ${DATA_FILE}`);
  console.log();
});

// Graceful Shutdown — Daten sofort speichern
function saveSync() {
  const data = {};
  for (const [key, room] of rooms) {
    data[key] = { nodes: room.nodes, lastAccess: room.lastAccess };
  }
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data), 'utf8');
    console.log('[Persistenz] Daten gespeichert.');
  } catch (e) {
    console.error('[Persistenz] Speichern fehlgeschlagen:', e.message);
  }
}

process.on('SIGINT', () => { saveSync(); process.exit(0); });
process.on('SIGTERM', () => { saveSync(); process.exit(0); });
