// encryption.js — Web Crypto API Wrapper (AES-GCM 256)
// Keine externen Dependencies — nutzt browser-native crypto.subtle.
//
// TODO: Implementation in Phase 2

/**
 * Neuen AES-GCM 256 Schlüssel generieren.
 * @param {boolean} [extractable=true]
 * @returns {Promise<CryptoKey>}
 */
export async function generateKey(extractable = true) {
  return crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

/**
 * CryptoKey als raw bytes exportieren.
 * @param {CryptoKey} key
 * @returns {Promise<Uint8Array>}
 */
export async function exportKey(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return new Uint8Array(raw);
}

/**
 * Raw bytes als CryptoKey importieren.
 * @param {Uint8Array} rawBytes
 * @param {boolean} [extractable=true]
 * @returns {Promise<CryptoKey>}
 */
export async function importKey(rawBytes, extractable = true) {
  return crypto.subtle.importKey(
    'raw', rawBytes,
    { name: 'AES-GCM', length: 256 },
    extractable,
    ['encrypt', 'decrypt']
  );
}

/**
 * Daten verschlüsseln. Gibt IV (12 bytes) + Ciphertext als Uint8Array zurück.
 * @param {CryptoKey} key
 * @param {Uint8Array|string} data
 * @returns {Promise<Uint8Array>}
 */
export async function encrypt(key, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = data instanceof Uint8Array ? data : new TextEncoder().encode(data);
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain);
  const result = new Uint8Array(12 + cipher.byteLength);
  result.set(iv, 0);
  result.set(new Uint8Array(cipher), 12);
  return result;
}

/**
 * Daten entschlüsseln. Input: IV (12 bytes) + Ciphertext.
 * @param {CryptoKey} key
 * @param {Uint8Array} data
 * @returns {Promise<ArrayBuffer>}
 */
export async function decrypt(key, data) {
  const iv = data.slice(0, 12);
  const cipher = data.slice(12);
  return crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
}

/**
 * Schlüssel aus Passphrase ableiten (PBKDF2, 600k Iterationen, SHA-256).
 * @param {string} passphrase
 * @param {Uint8Array} salt - 16 bytes
 * @returns {Promise<CryptoKey>}
 */
export async function deriveKeyFromPassphrase(passphrase, salt) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}
