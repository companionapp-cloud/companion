import { argon2id } from "hash-wasm";

// The cloud portal reimplements the server-facing auth-key derivation so it can log an
// end-to-end-encrypted account in WITHOUT sending the password (PLAN §E2EE). It derives ONLY the
// auth key — never the KEK or master key — so the portal still cannot read the user's data. The
// derivation MUST match core/crypto exactly (Argon2id → HKDF-SHA256, info "companion-auth-v1"),
// and is pinned by the Go test TestAuthKeyCrossImplVector; changing either side breaks login for
// existing encrypted accounts. See selfTestVector below for the shared test vector.

export interface KdfParams {
  time: number; // Argon2id iterations
  memoryK: number; // Argon2id memory in KiB
  threads: number; // Argon2id parallelism
}

const AUTH_INFO = "companion-auth-v1";
const KEY_LEN = 32;

// deriveAuthKey stretches the password with Argon2id, then HKDF-expands it into the 32-byte auth
// key, returned hex-encoded (the credential the server bcrypts). Mirrors core/crypto.AuthKeyHex.
export async function deriveAuthKey(password: string, saltB64: string, kdf: KdfParams): Promise<string> {
  const salt = base64ToBytes(saltB64);
  const stretched = await argon2id({
    password,
    salt,
    parallelism: kdf.threads,
    iterations: kdf.time,
    memorySize: kdf.memoryK, // KiB, matching golang.org/x/crypto/argon2
    hashLength: KEY_LEN,
    outputType: "binary",
  });
  // HKDF-SHA256 with a zero salt (Go's hkdf.New(sha256, secret, nil, info) uses a hashLen-zero
  // salt) and the auth info label, via built-in Web Crypto (no dependency, needs a secure context).
  // The inputs are copied into fresh ArrayBuffer-backed arrays so their types satisfy BufferSource.
  const key = await crypto.subtle.importKey("raw", new Uint8Array(stretched), "HKDF", false, ["deriveBits"]);
  const info = new Uint8Array(new TextEncoder().encode(AUTH_INFO));
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(KEY_LEN), info },
    key,
    KEY_LEN * 8,
  );
  return bytesToHex(new Uint8Array(bits));
}

// selfTestVector is the shared contract with the Go core (TestAuthKeyCrossImplVector). A dev can
// assert deriveAuthKey(password, salt, kdf) === expected to confirm the two implementations agree.
export const selfTestVector = {
  password: "correct horse battery staple",
  saltB64: "Y29tcGFuaW9uLXNhbHQxNg==",
  kdf: { time: 3, memoryK: 65536, threads: 4 } as KdfParams,
  expected: "d8046fc5a6b63f4972c0a423471b1d39fd1e4095bb440a205f4f35698afcdc7e",
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
}
