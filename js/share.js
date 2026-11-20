// share.js — Notebook teilen (QR/Link) und Sicherungsdatei packen/öffnen (Passphrase)
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
 * Sicherung mit einer Passphrase verschlüsseln.
 * Dateiformat: [16 Bytes Salt] + [12 Bytes IV] + AES-GCM-256(PBKDF2(passphrase, salt), JSON(payload))
 * @param {Object} payload - JSON-fähiges Objekt (Typ 'notizbuch-backup-v3')
 * @param {string} passphrase
 * @returns {Promise<Uint8Array>}
 */
export async function packBackup(payload, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passphraseKey = await deriveKeyFromPassphrase(passphrase, salt);
  const encrypted = await encrypt(passphraseKey, new TextEncoder().encode(JSON.stringify(payload)));
  const bundle = new Uint8Array(16 + encrypted.byteLength);
  bundle.set(salt, 0);
  bundle.set(encrypted, 16);
  return bundle;
}

/**
 * Passphrase-verschlüsselte Sicherung öffnen (auch das alte reine Schlüsselbündel,
 * das denselben Aufbau hat). Wirft bei falscher Passphrase oder fremder Datei.
 * @param {Uint8Array} bundleBytes
 * @param {string} passphrase
 * @returns {Promise<Object>} entschlüsseltes JSON-Objekt
 */
export async function unpackBackup(bundleBytes, passphrase) {
  if (!(bundleBytes instanceof Uint8Array) || bundleBytes.byteLength < 16 + 12 + 16) throw new Error('Datei zu kurz');
  const salt = bundleBytes.slice(0, 16);
  const passphraseKey = await deriveKeyFromPassphrase(passphrase, salt);
  const plainBuf = await decrypt(passphraseKey, bundleBytes.slice(16));
  return JSON.parse(new TextDecoder().decode(plainBuf));
}
