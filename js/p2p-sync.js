// p2p-sync.js — WebRTC P2P Sync via Trystero (Nostr Signaling)
// Signaling über öffentliche Nostr-Relays — kein eigener Server nötig.
// Datentransport via WebRTC DataChannel — direkte Peer-Verbindung.
//
// TODO: Implementation in Phase 2

/**
 * P2P-Room für ein Notebook beitreten.
 * @param {string} notebookId - Room-ID = Notebook-ID
 * @param {function(Uint8Array, string): void} onStroke - Callback bei eingehendem Stroke
 */
export function initP2P(notebookId, onStroke) {
  console.log('[P2P] TODO: joinRoom', notebookId);
}

/**
 * Verschlüsselten Stroke an alle Peers senden.
 * @param {Uint8Array} encryptedData
 */
export function broadcastStroke(encryptedData) {
  // TODO
}

/**
 * Aktuellen Room verlassen.
 */
export function leaveRoom() {
  // TODO
}
