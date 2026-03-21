/**
 * Notizbuch Dev-Server (HTTPS + WSS Relay)
 *
 * Kombinierter Server:
 *   - HTTPS: Statische Files aus dem Projektverzeichnis
 *   - WSS:   WebSocket Relay für persistenten Notebook-Sync
 *
 * Start:  node server.js
 * Dann:   https://192.168.100.49:4444/app.html
 *
 * Protokoll (JSON über WebSocket):
 *   Client → Server:
 *     { type: "join", room: "<roomKey>" }
 *     { type: "put", id: "<notebookId>", data: <notebook> }
 *     { type: "delete", id: "<notebookId>" }
 *
 *   Server → Client:
 *     { type: "sync", notebooks: { id: data, ... } }
 *     { type: "put", id: "<notebookId>", data: <notebook>, from: "<peerId>" }
 *     { type: "delete", id: "<notebookId>", from: "<peerId>" }
 *     { type: "peers", count: <number> }
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 4444;
const PROJECT_DIR = path.resolve(__dirname, '..');
const MAX_ROOM_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 Tage

// TLS-Zertifikat laden
const certPath = path.join(PROJECT_DIR, 'cert.pem');
const keyPath = path.join(PROJECT_DIR, 'key.pem');

if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
  console.error('Zertifikat nicht gefunden! Bitte cert.pem und key.pem im Projektverzeichnis anlegen.');
  console.error('  mkcert -cert-file cert.pem -key-file key.pem localhost 192.168.100.49');
  process.exit(1);
}

const serverOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath)
};

// MIME-Types
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
  '.webp': 'image/webp'
};

// HTTPS Server für statische Files
const httpsServer = https.createServer(serverOptions, (req, res) => {
  // URL bereinigen
  let urlPath = req.url.split('?')[0].split('#')[0];
  if (urlPath === '/') urlPath = '/index.html';

  // Pfad-Traversal verhindern
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

wss.on('connection', (ws) => {
  let currentRoom = null;
  const peerId = Math.random().toString(36).slice(2, 10);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {
      case 'join': {
        if (currentRoom) {
          currentRoom.clients.delete(ws);
          broadcastPeerCount(currentRoom);
        }
        const roomKey = String(msg.room || '').slice(0, 128);
        if (!roomKey) return;
        currentRoom = getRoom(roomKey);
        currentRoom.clients.add(ws);

        ws.send(JSON.stringify({ type: 'sync', notebooks: currentRoom.notebooks }));
        broadcastPeerCount(currentRoom);
        break;
      }

      case 'put': {
        if (!currentRoom || !msg.id || !msg.data) return;
        currentRoom.notebooks[String(msg.id)] = msg.data;
        broadcast(currentRoom, { type: 'put', id: String(msg.id), data: msg.data, from: peerId }, ws);
        break;
      }

      case 'delete': {
        if (!currentRoom || !msg.id) return;
        delete currentRoom.notebooks[String(msg.id)];
        broadcast(currentRoom, { type: 'delete', id: String(msg.id), from: peerId }, ws);
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

httpsServer.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  Notizbuch Dev-Server läuft:`);
  console.log(`    Lokal:   https://localhost:${PORT}/app.html`);
  console.log(`    WLAN:    https://192.168.100.49:${PORT}/app.html`);
  console.log(`    Relay:   wss://192.168.100.49:${PORT}`);
  console.log(`\n  Relay aktivieren (Browser-Konsole):`);
  console.log(`    localStorage.setItem('relayUrl', 'wss://192.168.100.49:${PORT}')`);
  console.log();
});
