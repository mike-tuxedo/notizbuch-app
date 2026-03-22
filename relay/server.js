/**
 * Notizbuch Dev-Server (HTTPS + WSS Relay + Debug Dashboard)
 *
 * Start:  node server.js
 *   App:       https://192.168.100.49:4444/app.html
 *   Dashboard: https://192.168.100.49:4444/debug.html
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4444;
const PROJECT_DIR = path.resolve(__dirname, '..');
const MAX_ROOM_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// TLS
const certPath = path.join(PROJECT_DIR, 'cert.pem');
const keyPath = path.join(PROJECT_DIR, 'key.pem');

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error('Zertifikat nicht gefunden!');
  console.error('  mkcert -cert-file cert.pem -key-file key.pem localhost 192.168.100.49');
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
      notebooks: Object.keys(room.notebooks).length,
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

// ─── WebSocket Relay ───

const rooms = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [key, room] of rooms) {
    if (now - room.lastAccess > MAX_ROOM_AGE_MS) rooms.delete(key);
  }
}, 6 * 60 * 60 * 1000);

function getRoom(roomKey) {
  let room = rooms.get(roomKey);
  if (!room) {
    room = { notebooks: {}, clients: new Set(), lastAccess: Date.now() };
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

  // Dashboard-Clients erkennen (via ?dashboard query param)
  if (req.url?.includes('dashboard=1')) {
    dashboardClients.add(ws);
    ws.send(JSON.stringify({ type: 'init', status: getStatus(), log: eventLog.slice(-50) }));
    ws.on('close', () => dashboardClients.delete(ws));
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

        const nbCount = Object.keys(currentRoom.notebooks).length;
        ws.send(JSON.stringify({ type: 'sync', notebooks: currentRoom.notebooks }));
        logEvent(currentRoomKey, peerId, 'join', `${nbCount} notebooks im Room`);
        broadcastPeerCount(currentRoom);
        broadcastDashboard({ type: 'status', status: getStatus() });
        break;
      }

      case 'put': {
        if (!currentRoom || !msg.id || !msg.data) return;
        currentRoom.notebooks[String(msg.id)] = msg.data;
        const size = JSON.stringify(msg.data).length;
        logEvent(currentRoomKey, peerId, 'put', `notebook ${String(msg.id).slice(0,8)}… (${(size/1024).toFixed(1)} KB)`);
        broadcast(currentRoom, { type: 'put', id: String(msg.id), data: msg.data, from: peerId }, ws);
        break;
      }

      case 'delete': {
        if (!currentRoom || !msg.id) return;
        delete currentRoom.notebooks[String(msg.id)];
        logEvent(currentRoomKey, peerId, 'delete', `notebook ${String(msg.id).slice(0,8)}…`);
        broadcast(currentRoom, { type: 'delete', id: String(msg.id), from: peerId }, ws);
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
  console.log(`\n  Notizbuch Dev-Server läuft:`);
  console.log(`    App:       https://localhost:${PORT}/app.html`);
  console.log(`    Dashboard: https://localhost:${PORT}/debug.html`);
  console.log(`    WLAN:      https://192.168.100.49:${PORT}/app.html`);
  console.log();
});
