// p2p-sync.js — WebRTC P2P Sync via Trystero (Nostr Signaling)
// Signaling über öffentliche Nostr-Relays — kein eigener Server nötig.
// Datentransport via WebRTC DataChannel — direkte Peer-Verbindung.
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

let room = null;
let _actions = {};

/**
 * P2P-Room beitreten.
 * @param {string} roomId - Room-ID (z.B. Hash des MasterKeys)
 * @param {Object} callbacks - Handler für eingehende Actions
 * @returns {Promise<void>}
 */
export async function initP2P(roomId, callbacks) {
  if (room) {
    try { room.leave(); } catch {}
    room = null;
    _actions = {};
  }

  try {
    const { joinRoom } = await import('https://esm.sh/trystero/nostr');
    room = joinRoom({ appId: APP_ID, relayUrls: NOSTR_RELAYS }, roomId);
  } catch (e) {
    console.error('[P2P] Trystero import/join fehlgeschlagen:', e);
    return;
  }

  // Alle Actions registrieren
  const actionNames = [
    'stroke', 'undo', 'clear', 'full-sync',
    'nb-created', 'nb-deleted', 'nb-renamed',
    'page-created', 'page-deleted', 'page-bg'
  ];

  for (const name of actionNames) {
    const [send, receive] = room.makeAction(name);
    _actions[name] = send;

    // Callback-Name: 'full-sync' → 'onFullSync', 'nb-created' → 'onNbCreated'
    const cbName = 'on' + name.split('-').map((s, i) =>
      s.charAt(0).toUpperCase() + s.slice(1)
    ).join('');

    receive((data, peerId) => {
      if (callbacks[cbName]) callbacks[cbName](data, peerId);
    });
  }

  room.onPeerJoin(peerId => {
    console.log('[P2P] Peer joined:', peerId);
    if (callbacks.onPeerJoin) callbacks.onPeerJoin(peerId);
  });
  room.onPeerLeave(peerId => {
    console.log('[P2P] Peer left:', peerId);
    if (callbacks.onPeerLeave) callbacks.onPeerLeave(peerId);
  });

  console.log('[P2P] Room beigetreten:', roomId);
}

/**
 * Action an alle Peers (oder einen bestimmten) senden.
 * @param {string} action - Action-Name
 * @param {*} data - Daten
 * @param {string} [peerId] - Nur an diesen Peer
 */
export function send(action, data, peerId) {
  const fn = _actions[action];
  if (!fn) {
    console.warn('[P2P] Action nicht registriert:', action);
    return;
  }
  try {
    if (peerId) fn(data, peerId);
    else fn(data);
  } catch (e) {
    console.error('[P2P] Senden fehlgeschlagen:', action, e);
  }
}

/** Aktuellen Room verlassen. */
export function leaveRoom() {
  if (room) {
    try { room.leave(); } catch {}
    room = null;
    _actions = {};
  }
}

/** Prüfen ob Room existiert (nicht ob Peers verbunden sind). */
export function isConnected() {
  return room !== null;
}

/** Prüfen ob tatsächlich Peers im Room sind. */
export function hasPeers() {
  if (!room) return false;
  try {
    const peers = room.getPeers();
    return Object.keys(peers).length > 0;
  } catch {
    return false;
  }
}
