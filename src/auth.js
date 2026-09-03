import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function parseCookies(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    cookies.set(name, value);
  }
  return cookies;
}

export async function createPasswordVerifier(expectedPassword, { store, username } = {}) {
  if (typeof expectedPassword !== "string" || expectedPassword.length > 1024) {
    throw new TypeError("Password must be a string of at most 1024 characters");
  }
  if (store && (typeof username !== "string" || !username)) {
    throw new TypeError("A username is required to bind stored sessions to credentials");
  }
  const state = store?.getCredentialState();
  const salt = state && /^[0-9a-f]{32}$/.test(state.salt)
    ? Buffer.from(state.salt, "hex")
    : randomBytes(16);
  const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const expected = await scryptAsync(expectedPassword, salt, 32, options);
  if (store) store.syncCredentials(username, salt.toString("hex"), expected.toString("hex"));
  return async (candidate) => {
    if (typeof candidate !== "string" || candidate.length > 1024) return false;
    const actual = await scryptAsync(candidate, salt, 32, options);
    return timingSafeEqual(expected, actual);
  };
}

export function createSession(store, username, sessionDays) {
  const token = randomBytes(32).toString("base64url");
  const now = Date.now();
  const expiresAt = now + sessionDays * 24 * 60 * 60 * 1000;
  store.createSession(hashToken(token), username, now, expiresAt);
  return { token, expiresAt };
}

export class LoginLimiter {
  constructor({ attempts = 5, windowMs = 15 * 60 * 1000, maxEntries = 10_000 } = {}) {
    for (const [name, value] of Object.entries({ attempts, windowMs, maxEntries })) {
      if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive integer`);
    }
    this.attempts = attempts;
    this.windowMs = windowMs;
    this.maxEntries = maxEntries;
    this.entries = new Map();
    this.nextCleanupAt = 0;
  }

  prune(now) {
    if (now < this.nextCleanupAt) return;
    let next = Infinity;
    for (const [key, entry] of this.entries) {
      if (entry.resetAt <= now) this.entries.delete(key);
      else next = Math.min(next, entry.resetAt);
    }
    this.nextCleanupAt = next;
  }

  allowed(key, now = Date.now()) {
    this.prune(now);
    const entry = this.entries.get(key);
    return entry ? entry.count < this.attempts : this.entries.size < this.maxEntries;
  }

  fail(key, now = Date.now()) {
    this.prune(now);
    const entry = this.entries.get(key);
    if (!entry) {
      if (this.entries.size >= this.maxEntries) return;
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
      this.nextCleanupAt = Math.min(this.nextCleanupAt, now + this.windowMs);
    } else {
      entry.count += 1;
    }
  }

  success(key) {
    this.entries.delete(key);
  }
}
