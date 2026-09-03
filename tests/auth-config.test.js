import test from "node:test";
import assert from "node:assert/strict";
import { createPasswordVerifier, LoginLimiter, parseCookies } from "../src/auth.js";
import { loadConfig } from "../src/config.js";

const validEnv = { CLIP_PASSWORD: "correct-horse-battery-staple" };

test("configuration accepts documented defaults and explicit settings", () => {
  const defaults = loadConfig(validEnv);
  assert.equal(defaults.port, 8080);
  assert.equal(defaults.username, "admin");
  assert.equal(defaults.cookieSecure, true);
  assert.equal(defaults.maxTextBytes, 1024 * 1024);

  const config = loadConfig({
    ...validEnv,
    CLIP_DOMAIN: " Clip.Example.com ",
    CLIP_USERNAME: " my-user ",
    CLIP_PORT: "65535",
    CLIP_COOKIE_SECURE: " FALSE ",
    CLIP_RETENTION_HOURS: "1",
  });
  assert.equal(config.domain, "clip.example.com");
  assert.equal(config.username, "my-user");
  assert.equal(config.port, 65535);
  assert.equal(config.cookieSecure, false);
  assert.equal(config.retentionHours, 1);
});

test("configuration rejects partially parsed integers and out-of-range limits", () => {
  const limits = [
    ["CLIP_PORT", 65535],
    ["CLIP_RETENTION_HOURS", 8760],
    ["CLIP_MAX_FILE_MB", 10240],
    ["CLIP_MAX_STORAGE_GB", 1024],
    ["CLIP_MAX_TEXT_KB", 4096],
    ["CLIP_SESSION_DAYS", 365],
  ];
  for (const [name, maximum] of limits) {
    for (const value of ["1.5", "1junk", "1e2", "0x10", " ", "0", "-1", String(maximum + 1)]) {
      assert.throws(() => loadConfig({ ...validEnv, [name]: value }), new RegExp(name));
    }
  }
});

test("configuration rejects unusable credentials and malformed hostnames", () => {
  for (const password of ["", "short", " ".repeat(12), "x".repeat(1025), "replace-with-a-long-random-password"]) {
    assert.throws(() => loadConfig({ CLIP_PASSWORD: password }), /CLIP_PASSWORD/);
  }
  for (const username of [" ", "user\nname", "x".repeat(129)]) {
    assert.throws(() => loadConfig({ ...validEnv, CLIP_USERNAME: username }), /CLIP_USERNAME/);
  }
  for (const domain of ["https://example.com", "example.com/path", "example.com:8080", ".", "a..b", "-host.test", "host-.test", `${"a".repeat(64)}.test`]) {
    assert.throws(() => loadConfig({ ...validEnv, CLIP_DOMAIN: domain }), /CLIP_DOMAIN/);
  }
  assert.throws(() => loadConfig({ ...validEnv, CLIP_COOKIE_SECURE: "flase" }), /CLIP_COOKIE_SECURE/);
});

test("password verification rejects incorrect, oversized, and non-string candidates", async () => {
  const verify = await createPasswordVerifier(validEnv.CLIP_PASSWORD);
  assert.equal(await verify(validEnv.CLIP_PASSWORD), true);
  assert.equal(await verify("wrong-password"), false);
  assert.equal(await verify("x".repeat(1025)), false);
  assert.equal(await verify(null), false);
});

test("login limiter enforces the failure window and clears successful logins", () => {
  const limiter = new LoginLimiter({ attempts: 2, windowMs: 100 });
  assert.equal(limiter.allowed("device", 0), true);
  limiter.fail("device", 0);
  assert.equal(limiter.allowed("device", 99), true);
  limiter.fail("device", 99);
  assert.equal(limiter.allowed("device", 99), false);
  assert.equal(limiter.allowed("device", 100), true);
  limiter.fail("device", 100);
  limiter.success("device");
  assert.equal(limiter.entries.size, 0);
  assert.equal(limiter.allowed("device", 101), true);
});

test("login limiter bounds tracked addresses and reclaims expired entries", () => {
  const limiter = new LoginLimiter({ attempts: 2, windowMs: 100, maxEntries: 2 });
  limiter.fail("one", 0);
  limiter.fail("two", 10);
  assert.equal(limiter.allowed("three", 50), false);
  limiter.fail("three", 50);
  assert.equal(limiter.entries.size, 2);
  assert.equal(limiter.allowed("one", 50), true);
  assert.equal(limiter.allowed("three", 100), true);
  assert.equal(limiter.entries.has("one"), false);
  assert.equal(limiter.entries.has("two"), true);
  limiter.fail("three", 100);
  assert.equal(limiter.allowed("four", 200), true);
  assert.equal(limiter.entries.size, 0);
});

test("cookie parsing keeps opaque token values and ignores malformed entries", () => {
  assert.deepEqual([...parseCookies("broken; clip_session=abc=def; other=two")], [
    ["clip_session", "abc=def"],
    ["other", "two"],
  ]);
  assert.equal(parseCookies().size, 0);
});
