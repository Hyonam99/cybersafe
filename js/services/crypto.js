// Password hashing with PBKDF2-SHA256 (Web Crypto API) and a random 16-byte salt.
const ITERATIONS = 100000;
const enc = new TextEncoder();
const b64 = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return `pbkdf2$${ITERATIONS}$${b64(salt)}$${b64(await derive(password, salt, ITERATIONS))}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, salt, hash] = String(stored).split('$');
  if (scheme !== 'pbkdf2') return false;
  const got = new Uint8Array(await derive(password, unb64(salt), Number(iter)));
  const want = unb64(hash);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got[i] ^ want[i];
  return diff === 0;
}

// Six-character join code from a 31-character alphabet (no 0, O, 1, I or L).
export const JOIN_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function makeJoinCode() {
  const r = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(r, x => JOIN_ALPHABET[x % JOIN_ALPHABET.length]).join('');
}
