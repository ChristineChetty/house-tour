// Decrypts files written by scripts/encrypt-assets.mjs.
// Layout: salt (16) | iv (12) | AES-256-GCM ciphertext with the 16-byte tag appended.
// Key: PBKDF2-SHA256, 600 000 iterations. The script uses one salt per run, so the key
// is derived once and cached by salt for the rest of the visit (memory only).

const SALT_LEN = 16;
const IV_LEN = 12;
const ITERATIONS = 600000;

const keys = new Map();

function hex(bytes) {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function deriveKey(password, salt) {
  const id = hex(salt);
  if (!keys.has(id)) {
    const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    keys.set(
      id,
      crypto.subtle.deriveKey(
        { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
        base,
        { name: 'AES-GCM', length: 256 },
        false,
        ['decrypt'],
      ),
    );
  }
  return keys.get(id);
}

// Throws a DOMException named 'OperationError' when the password is wrong.
export async function decrypt(buffer, password) {
  const bytes = new Uint8Array(buffer);
  const salt = bytes.subarray(0, SALT_LEN);
  const iv = bytes.subarray(SALT_LEN, SALT_LEN + IV_LEN);
  const key = await deriveKey(password, salt);
  try {
    return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, bytes.subarray(SALT_LEN + IV_LEN));
  } catch (err) {
    keys.delete(hex(salt));
    throw err;
  }
}
