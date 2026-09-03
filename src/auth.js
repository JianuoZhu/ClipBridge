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

export async function createPasswordVerifier(expectedPassword) {
  const salt = randomBytes(16);
  const options = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
  const expected = await scryptAsync(expectedPassword, salt, 32, options);
  return async (candidate) => {
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
  constructor({ attempts = 5, windowMs = 15 * 60 * 1000 } = {}) {
    this.attempts = attempts;
    this.windowMs = windowMs;
    this.entries = new Map();
  }

  allowed(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 0, resetAt: now + this.windowMs });
      return true;
    }
    return entry.count < this.attempts;
  }

  fail(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry || entry.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    } else {
      entry.count += 1;
    }
  }

  success(key) {
    this.entries.delete(key);
  }
}
