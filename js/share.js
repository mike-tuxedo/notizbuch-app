// share.js — Notebook teilen (QR/Link) und App Export/Import (Passphrase)
// Der Notebook-Key landet ausschließlich im URL-Fragment (#) — nie am Server.
//
// TODO: Implementation in Phase 2

import { exportKey, importKey, encrypt, decrypt, deriveKeyFromPassphrase } from './encryption.js';

/**
 * Invite-Link für ein Notebook generieren.
 * Der Key ist nur im Fragment — Browser sendet ihn nie an den Server.
 * @param {string} notebookId
 * @param {CryptoKey} notebookKey
 * @returns {Promise<string>} Vollständiger Invite-Link
 */
export async function generateInviteLink(notebookId, notebookKey) {
  const raw = await exportKey(notebookKey);
  const b64 = btoa(String.fromCharCode(...raw));
  const base = `${location.origin}${location.pathname}`;
  return `${base}#nb=${notebookId}&k=${encodeURIComponent(b64)}`;
}

/**
 * Invite-Link aus URL-Fragment parsen.
 * @returns {Promise<{notebookId: string, key: CryptoKey}|null>}
 */
export async function parseInviteLink() {
  if (!location.hash || location.hash.length < 5) return null;
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    const notebookId = params.get('nb');
    const keyB64 = params.get('k');
    if (!notebookId || !keyB64) return null;
    const raw = Uint8Array.from(atob(keyB64), c => c.charCodeAt(0));
    const key = await importKey(raw, true);
    return { notebookId, key };
  } catch {
    return null;
  }
}

/**
 * QR-Code als Data-URL generieren.
 * @param {string} text
 * @returns {Promise<string|null>}
 */
export async function generateQRDataURL(text) {
  try {
    // qrcode.min.js ist lokal in libs/ — kein CDN-Import
    if (typeof QRCode !== 'undefined') {
      const canvas = document.createElement('canvas');
      QRCode.toCanvas(canvas, text, { width: 240, margin: 2 });
      return canvas.toDataURL();
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Alle Schlüssel als verschlüsseltes Bundle exportieren.
 * Format: [16 bytes Salt] + AES-GCM-encrypt(passphrase, JSON(keys))
 * @param {CryptoKey} masterKey
 * @param {Object<string, CryptoKey>} notebookKeyMap
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>}
 */
export async function exportAppBundle(masterKey, notebookKeyMap, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passphraseKey = await deriveKeyFromPassphrase(passphrase, salt);

  const rawMaster = await exportKey(masterKey);
  const notebookKeys = {};
  for (const [id, key] of Object.entries(notebookKeyMap)) {
    notebookKeys[id] = Array.from(await exportKey(key));
  }

  const payload = new TextEncoder().encode(JSON.stringify({
    masterKey: Array.from(rawMaster),
    notebookKeys,
    exportedAt: new Date().toISOString(),
  }));

  const encrypted = await encrypt(passphraseKey, payload);
  const bundle = new Uint8Array(16 + encrypted.byteLength);
  bundle.set(salt, 0);
  bundle.set(encrypted, 16);
  return bundle;
}

/**
 * Verschlüsseltes Bundle importieren.
 * @param {Uint8Array} bundleBytes
 * @param {string} passphrase
 * @returns {Promise<{masterKey: CryptoKey, notebookKeyMap: Object<string, CryptoKey>}>}
 */
export async function importAppBundle(bundleBytes, passphrase) {
  const salt = bundleBytes.slice(0, 16);
  const encrypted = bundleBytes.slice(16);
  const passphraseKey = await deriveKeyFromPassphrase(passphrase, salt);

  const plainBuf = await decrypt(passphraseKey, encrypted);
  const { masterKey: rawMaster, notebookKeys: rawNbKeys } = JSON.parse(
    new TextDecoder().decode(plainBuf)
  );

  const masterKey = await importKey(new Uint8Array(rawMaster), true);
  const notebookKeyMap = {};
  for (const [id, raw] of Object.entries(rawNbKeys)) {
    notebookKeyMap[id] = await importKey(new Uint8Array(raw), true);
  }
  return { masterKey, notebookKeyMap };
}
