// p2p-sync.js — WebRTC P2P Sync via Trystero (Nostr Signaling)
// Signaling über öffentliche Nostr-Relays — kein eigener Server nötig.
// Datentransport via WebRTC DataChannel — direkte Peer-Verbindung.
//
// Multi-Room Support:
//   - Haupt-Room (masterKeyHash): eigene Geräte, kompletter App-State
//   - Shared-Rooms (notebookHash): pro geteiltem Notebook, nur Notebook-Daten
//
// Actions:
//   'stroke'       — Ein neuer Stroke
//   'undo'         — Letzter Stroke gelöscht
//   'clear'        — Seite geleert
//   'full-sync'    — Kompletter State (alle Notebooks, Pages, Strokes)
//   'nb-created'   — Neues Notebook
//   'nb-deleted'   — Notebook gelöscht
//   'nb-renamed'   — Notebook umbenannt
//   'page-created' — Neue Seite
//   'page-deleted' — Seite gelöscht
//   'page-bg'      — Seiten-Hintergrund geändert

/** @type {string} App-ID für Trystero Room-Naming */
const APP_ID = 'notizbuch-v2';

/** Nostr-Relays für Signaling (Pool — Trystero verbindet zu allen) */
const NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.wine',
  'wss://relay.primal.net',
  'wss://purplepag.es',
];

const ACTION_NAMES = [
  'stroke', 'undo', 'clear', 'full-sync',
  'nb-created', 'nb-deleted', 'nb-renamed',
  'page-created', 'page-deleted', 'page-bg'
];

/** @type {Map<string, {room: any, actions: Object, callbacks: Object, isMain: boolean}>} */
const rooms = new Map();

/** @type {string|null} ID des Haupt-Rooms (= masterKeyHash) */
let mainRoomId = null;

/** @type {Function|null} Cached joinRoom function */
let _joinRoom = null;

async function ensureTrystero() {
  if (_joinRoom) return _joinRoom;
  const mod = await import('https://esm.sh/trystero/nostr');
  _joinRoom = mod.joinRoom;
  return _joinRoom;
}

function actionCallbackName(action) {
  return 'on' + action.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

async function _joinAnyRoom(roomId, callbacks, isMain) {
  // Bestehenden Room verlassen falls vorhanden
  const existing = rooms.get(roomId);
  if (existing) {
    try { existing.room.leave(); } catch {}
    rooms.delete(roomId);
  }

  let joinRoom;
  try { joinRoom = await ensureTrystero(); }
  catch (e) { console.error('[P2P] Trystero Import fehlgeschlagen:', e); return; }

  let room;
  try { room = joinRoom({ appId: APP_ID, relayUrls: NOSTR_RELAYS }, roomId); }
  catch (e) { console.error('[P2P] Room-Join fehlgeschlagen:', e); return; }

  const actions = {};
  for (const name of ACTION_NAMES) {
    const [send, receive] = room.makeAction(name);
    actions[name] = send;
    const cbName = actionCallbackName(name);
    receive((data, peerId) => {
      if (callbacks[cbName]) callbacks[cbName](data, peerId, roomId);
    });
  }

  room.onPeerJoin(peerId => {
    console.log(`[P2P] Peer joined ${isMain ? '(main)' : '(shared)'}:`, peerId, '@', roomId.slice(0, 8));
    if (callbacks.onPeerJoin) callbacks.onPeerJoin(peerId, roomId);
  });
  room.onPeerLeave(peerId => {
    console.log(`[P2P] Peer left ${isMain ? '(main)' : '(shared)'}:`, peerId, '@', roomId.slice(0, 8));
    if (callbacks.onPeerLeave) callbacks.onPeerLeave(peerId, roomId);
  });

  rooms.set(roomId, { room, actions, callbacks, isMain });
  console.log(`[P2P] Room beigetreten ${isMain ? '(main)' : '(shared)'}:`, roomId.slice(0, 8));
}

/**
 * Haupt-Room beitreten (eigene Geräte).
 * @param {string} roomId - masterKeyHash
 * @param {Object} callbacks - Handler für eingehende Actions
 */
export async function initP2P(roomId, callbacks) {
  mainRoomId = roomId;
  await _joinAnyRoom(roomId, callbacks, true);
}

/**
 * Shared-Room beitreten (geteiltes Notebook).
 * @param {string} roomId - notebookHash
 * @param {Object} callbacks - Handler für eingehende Actions (gleiche wie Haupt-Room)
 */
export async function joinSharedRoom(roomId, callbacks) {
  if (rooms.has(roomId)) return;
  await _joinAnyRoom(roomId, callbacks, false);
}

/**
 * Shared-Room verlassen.
 * @param {string} roomId
 */
export function leaveSharedRoom(roomId) {
  const entry = rooms.get(roomId);
  if (!entry) return;
  try { entry.room.leave(); } catch {}
  rooms.delete(roomId);
}

/**
 * Action senden. Standard: an Haupt-Room. Mit `roomId`: an spezifischen Room.
 * @param {string} action - Action-Name
 * @param {*} data - Daten
 * @param {{peerId?: string, roomId?: string}} [opts]
 */
export function send(action, data, opts = {}) {
  const targetRoomId = opts.roomId || mainRoomId;
  const entry = rooms.get(targetRoomId);
  if (!entry) {
    console.warn('[P2P] Room nicht verfügbar:', targetRoomId?.slice(0, 8));
    return;
  }
  const fn = entry.actions[action];
  if (!fn) {
    console.warn('[P2P] Action nicht registriert:', action);
    return;
  }
  try {
    if (opts.peerId) fn(data, opts.peerId);
    else fn(data);
  } catch (e) {
    console.error('[P2P] Senden fehlgeschlagen:', action, e);
  }
}

/**
 * Action an mehrere Rooms senden (Haupt + alle Shared).
 * Für Strokes etc. die sowohl an eigene Geräte als auch an geteilte Peers sollen.
 */
export function sendToAll(action, data) {
  for (const [roomId] of rooms) {
    send(action, data, { roomId });
  }
}

/** Alle Rooms verlassen. */
export function leaveAllRooms() {
  for (const [, entry] of rooms) {
    try { entry.room.leave(); } catch {}
  }
  rooms.clear();
  mainRoomId = null;
}

/** Aktuellen Haupt-Room verlassen (Kompatibilität). */
export function leaveRoom() {
  leaveAllRooms();
}

/** Prüfen ob Haupt-Room existiert. */
export function isConnected() {
  return mainRoomId !== null && rooms.has(mainRoomId);
}

/** Prüfen ob im Haupt-Room Peers sind. */
export function hasPeers() {
  const entry = rooms.get(mainRoomId);
  if (!entry) return false;
  try {
    const peers = entry.room.getPeers();
    return Object.keys(peers).length > 0;
  } catch {
    return false;
  }
}

/** Anzahl Peers in einem Room. */
export function peerCount(roomId = mainRoomId) {
  const entry = rooms.get(roomId);
  if (!entry) return 0;
  try { return Object.keys(entry.room.getPeers()).length; }
  catch { return 0; }
}
