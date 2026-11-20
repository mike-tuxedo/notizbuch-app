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
//   'redo'         — Undo aufgehoben (Redo-Event mit targetEventId)
//   'edit'         — Objekt geändert (Edit-Event: verschieben, Größe, Farbe, Füllung)
//   'clear'        — Seite geleert
//   'full-sync'    — Kompletter State (alle Notebooks, Pages, Strokes)
//   'nb-created'   — Neues Notebook
//   'nb-deleted'   — Notebook gelöscht
//   'nb-renamed'   — Notebook umbenannt
//   'page-created' — Neue Seite
//   'page-deleted' — Seite weich gelöscht (Tombstone)
//   'page-restored'— Gelöschte Seite wiederhergestellt
//   'page-bg'      — Seiten-Hintergrund geändert

/** @type {string} App-ID für Trystero Room-Naming */
const APP_ID = 'notizbuch-v2';

// Signaling-Relays: Trystero wählt selbst aus seiner Standardliste (pro appId
// deterministisch, alle Geräte landen also auf denselben Relays). Eine eigene
// Liste müsste als `relayConfig: { urls: [...] }` übergeben werden — vorher
// jede URL prüfen, viele öffentliche Nostr-Relays nehmen keine Events an.

const ACTION_NAMES = [
  'stroke', 'undo', 'redo', 'edit', 'clear', 'full-sync',
  'nb-created', 'nb-deleted', 'nb-renamed',
  'page-created', 'page-deleted', 'page-restored', 'page-bg'
];

/** @type {Map<string, {room: any, actions: Object, callbacks: Object, isMain: boolean}>} */
const rooms = new Map();

/** @type {string|null} ID des Haupt-Rooms (= masterKeyHash) */
let mainRoomId = null;

/** @type {Function|null} Cached joinRoom function */
let _joinRoom = null;

/** ICE-Einstellungen (device-lokal, niemals synchronisieren/exportieren) */
let _iceSettings = { turnUrl: '', username: '', credential: '' };

/** Gecachtes ICE-Ergebnis */
let _iceCache = null;
let _iceCacheTime = 0;
let _iceFetchPromise = null;
let _iceLastError = null;

const ICE_TTL_MS = 10 * 60 * 1000;

async function ensureTrystero() {
  if (_joinRoom) return _joinRoom;
  const mod = await import('https://esm.sh/trystero@0.24.0/nostr');
  _joinRoom = mod.joinRoom;
  return _joinRoom;
}

function actionCallbackName(action) {
  return 'on' + action.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/**
 * ICE-Einstellungen setzen. Leert den ICE-Cache, damit beim nächsten
 * Beitritt die aktuelle Konfiguration verwendet wird.
 * @param {{turnUrl?: string, username?: string, credential?: string}} settings
 */
export function setIceSettings({ turnUrl = '', username = '', credential = '' } = {}) {
  _iceSettings = {
    turnUrl: String(turnUrl || '').trim(),
    username: String(username || '').trim(),
    credential: String(credential || '').trim()
  };
  _iceCache = null;
  _iceCacheTime = 0;
  _iceFetchPromise = null;
  _iceLastError = null;
}

/**
 * ICE-Zusatz für joinRoom bauen.
 * @returns {Promise<{rtcConfig?: {iceServers: Array<Object>}, turnConfig?: Array<Object>}>}
 */
async function _buildIceAddition() {
  const url = _iceSettings.turnUrl;
  if (!url) return {};

  // Direktangabe eines oder mehrerer TURN/TURNS-Server
  if (url.startsWith('turn:') || url.startsWith('turns:')) {
    const urls = url.split(/[\s,]+/).filter(u => u.startsWith('turn:') || u.startsWith('turns:'));
    if (urls.length === 0) {
      _iceLastError = 'keine gültigen turn:/turns:-URLs';
      return {};
    }
    return {
      turnConfig: [{
        urls,
        username: _iceSettings.username || '',
        credential: _iceSettings.credential || ''
      }]
    };
  }

  // HTTPS-Endpunkt: JSON mit {iceServers: [...]} holen
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return _fetchIceEndpoint(url);
  }

  _iceLastError = 'ungültiges Format';
  return {};
}

async function _fetchIceEndpoint(url) {
  if (_iceCache && (Date.now() - _iceCacheTime) < ICE_TTL_MS) {
    return { rtcConfig: { iceServers: _iceCache } };
  }
  if (_iceFetchPromise) {
    const liste = await _iceFetchPromise;
    return liste.length ? { rtcConfig: { iceServers: liste } } : {};
  }

  _iceFetchPromise = (async () => {
    try {
      const ab = new AbortController();
      const timer = setTimeout(() => ab.abort(), 4000);
      let res;
      try { res = await fetch(url, { cache: 'no-store', signal: ab.signal }); }
      finally { clearTimeout(timer); }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      const liste = Array.isArray(data) ? data : (data?.iceServers || []);
      if (!liste.length) {
        _iceLastError = 'Antwort leer';
        return [];
      }
      _iceCache = liste;
      _iceCacheTime = Date.now();
      _iceLastError = null;
      return liste;
    } catch (e) {
      _iceLastError = (e && e.message) || String(e);
      return [];
    } finally {
      _iceFetchPromise = null;
    }
  })();

  const liste = await _iceFetchPromise;
  return liste.length ? { rtcConfig: { iceServers: liste } } : {};
}

async function _joinAnyRoom(roomId, callbacks, isMain) {
  // Bestehenden Room verlassen falls vorhanden
  const existing = rooms.get(roomId);
  if (existing) {
    try { await Promise.resolve(existing.room.leave()); } catch {}
    rooms.delete(roomId);
  }

  let joinRoom;
  try { joinRoom = await ensureTrystero(); }
  catch (e) { console.error('[P2P] Trystero Import fehlgeschlagen:', e); return; }

  const config = { appId: APP_ID };
  try {
    const iceAddition = await _buildIceAddition();
    Object.assign(config, iceAddition);
  } catch (e) {
    console.warn('[P2P] ICE-Konfiguration konnte nicht gebaut werden:', e);
  }

  let room;
  try { room = joinRoom(config, roomId); }
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

/** Kurzer Status-String für die Debug-Anzeige (keine Zugangsdaten!). */
export function getIceStatus() {
  const url = _iceSettings.turnUrl;
  if (!url) return 'standard (nur STUN)';
  if (url.startsWith('turn:') || url.startsWith('turns:')) {
    const n = url.split(/[\s,]+/).filter(u => u.startsWith('turn:') || u.startsWith('turns:')).length;
    return `turn direkt (${n} URL${n === 1 ? '' : 's'})`;
  }
  if (url.startsWith('http://') || url.startsWith('https://')) {
    if (_iceCache) {
      return `endpunkt ok (${_iceCache.length} Server)`;
    }
    if (_iceLastError) {
      return `endpunkt fehler: ${_iceLastError}`;
    }
    return 'endpunkt wird geladen…';
  }
  return 'ungültig';
}

/**
 * Diagnose-Informationen zu allen Peers aller Rooms.
 * @returns {Promise<Array<{roomId: string, isMain: boolean, peerId: string, iceState: string, connState: string, localType: string, remoteType: string, protocol: string}>>}
 */
export async function getPeerDiagnostics() {
  const results = [];
  for (const [roomId, entry] of rooms) {
    let peers;
    try { peers = entry.room.getPeers(); }
    catch { continue; }
    for (const [peerId, pc] of Object.entries(peers)) {
      const row = {
        roomId,
        isMain: entry.isMain,
        peerId,
        iceState: '-',
        connState: '-',
        localType: '-',
        remoteType: '-',
        protocol: '-'
      };
      try {
        if (pc) {
          row.iceState = pc.iceConnectionState || '-';
          row.connState = pc.connectionState || '-';
          const stats = await pc.getStats();
          let pairId = null;
          let transport = null;
          for (const [id, s] of stats) {
            if (s.type === 'transport') {
              transport = s;
              if (s.selectedCandidatePairId) {
                pairId = s.selectedCandidatePairId;
                break;
              }
            }
          }
          if (!pairId) {
            for (const [id, s] of stats) {
              if (s.type === 'candidate-pair' && ((s.nominated && s.state === 'succeeded') || s.selected)) {
                pairId = id;
                break;
              }
            }
          }
          if (pairId) {
            const pair = stats.get(pairId);
            if (pair) {
              const local = stats.get(pair.localCandidateId);
              const remote = stats.get(pair.remoteCandidateId);
              if (local) row.localType = local.candidateType || '-';
              if (remote) row.remoteType = remote.candidateType || '-';
              if (local && local.protocol) row.protocol = local.protocol;
              else if (remote && remote.protocol) row.protocol = remote.protocol;
            }
          }
        }
      } catch {
        // Fehler dürfen nie nach außen dringen
      }
      results.push(row);
    }
  }
  return results;
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
