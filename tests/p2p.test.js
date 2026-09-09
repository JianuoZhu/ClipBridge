import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createSession, hashToken } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createClipServer } from "../src/server.js";
import { createP2pSignaling } from "../src/p2p.js";
import { Store } from "../src/store.js";
import { listenOnLoopback } from "./support/listen.js";

const secret = "test_gateway_secret_01234567890123456789";
const offer = { type: "offer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };
const answer = { type: "answer", sdp: "v=0\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n" };

async function fixture(t, respond = (_req, res) => res.end(JSON.stringify({ answer })), enabled = true) {
  const gateway = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    req.payload = JSON.parse(Buffer.concat(chunks));
    respond(req, res);
  });
  await listenOnLoopback(gateway);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-p2p-test-"));
  const config = loadConfig({ CLIP_DATA_DIR: dataDir, CLIP_COOKIE_SECURE: "false",
    CLIP_P2P_ENABLED: String(enabled), CLIP_P2P_SECRET: secret,
    CLIP_P2P_GATEWAY_URL: `http://127.0.0.1:${gateway.address().port}` });
  const store = new Store(dataDir);
  const app = await createClipServer({ config, store });
  await listenOnLoopback(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = createSession(store, "member", 1);
  const cookie = `clip_session=${session.token}`;
  const request = (url, options = {}) => fetch(base + url, {
    ...options, headers: { Cookie: cookie, "X-Clip-Request": "1", ...options.headers }, signal: AbortSignal.timeout(5000),
  });
  t.after(async () => {
    app.server.closeAllConnections(); gateway.closeAllConnections();
    await Promise.all([new Promise((resolve) => app.close(resolve)), new Promise((resolve) => gateway.close(resolve))]);
    store.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^clip-p2p-test-/);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { request, base, store, session, cookie };
}

test("P2P config defaults disabled and validates internal endpoint, secret and STUN servers", () => {
  assert.equal(loadConfig({}).p2p.enabled, false);
  assert.throws(() => loadConfig({ CLIP_P2P_ENABLED: "yes" }), /CLIP_P2P_ENABLED/);
  assert.throws(() => loadConfig({ CLIP_P2P_ENABLED: "true" }), /CLIP_P2P_SECRET/);
  for (const url of ["https://127.0.0.1", "http://example.com", "http://user:pass@localhost", "http://localhost/path", "http://localhost?x=1"]) {
    assert.throws(() => loadConfig({ CLIP_P2P_GATEWAY_URL: url }), /CLIP_P2P_GATEWAY_URL/);
  }
  for (const urls of ["turn:example.com:3478", "stun:example.com:65536", "stun:example.com:0", "https://example.com", "stun:user@example.com"]) {
    assert.throws(() => loadConfig({ CLIP_P2P_STUN_URLS: urls }), /CLIP_P2P_STUN_URLS/);
  }
  assert.deepEqual(loadConfig({ CLIP_P2P_STUN_URLS: "" }).p2p.stunUrls, []);
});

test("signaling requires login and same-origin mutation and never discloses the gateway secret", async (t) => {
  let calls = 0;
  const ctx = await fixture(t, (_req, res) => { calls++; res.end(JSON.stringify({ answer })); });
  assert.equal((await fetch(ctx.base + "/api/p2p/config")).status, 401);
  const response = await ctx.request("/api/p2p/config");
  const settings = await response.json();
  assert.equal(settings.enabled, true);
  assert.ok(settings.iceServers.length);
  assert.equal(JSON.stringify(settings).includes(secret), false);
  assert.equal((await ctx.request("/api/p2p/offer", { method: "POST", headers: { Origin: "https://evil.example" }, body: JSON.stringify({ offer }) })).status, 403);
  assert.equal((await ctx.request("/api/p2p/offer", { method: "POST", headers: { "X-Clip-Request": "" }, body: JSON.stringify({ offer }) })).status, 403);
  assert.equal(calls, 0);
});

test("gateway identity comes from the authenticated session, not browser-supplied values", async (t) => {
  let received;
  const ctx = await fixture(t, (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${secret}`);
    received = req.payload;
    res.end(JSON.stringify({ answer, cookie: "never expose", secret }));
  });
  const response = await ctx.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer,
    cookie: "clip_session=attacker", host: "evil.example", expiresAt: Number.MAX_SAFE_INTEGER }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { answer });
  assert.equal(received.cookie, ctx.cookie);
  assert.equal(received.host, new URL(ctx.base).host);
  assert.ok(received.expiresAt <= Date.now() + 30 * 60 * 1000);
  assert.equal(received.offer.sdp, offer.sdp);
});

test("latency probes require a current session and cannot be cached", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await fetch(ctx.base + "/api/connection/ping")).status, 401);
  const response = await ctx.request("/api/connection/ping?sample=1");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await response.json(), { ok: true });
});

test("disabled, failed and malformed negotiation preserve a usable HTTP service", async (t) => {
  const disabled = await fixture(t, undefined, false);
  assert.equal((await disabled.request("/api/p2p/config").then((r) => r.json())).enabled, false);
  const disabledResponse = await disabled.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) });
  assert.equal(disabledResponse.status, 503);
  assert.equal((await disabledResponse.json()).code, "P2P_DISABLED");
  const failed = await fixture(t, (_req, res) => { res.writeHead(500); res.end("private internal error"); });
  const response = await failed.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) });
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("private internal"), false);
  const invalid = await failed.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer: { ...offer, sdp: "v=0\nm=audio 9\nm=application 9" } }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).code, "P2P_INVALID_OFFER");
  assert.equal((await failed.request("/api/items/text", { method: "POST", body: JSON.stringify({ text: "HTTPS still saves" }) })).status, 201);
});

test("revocation during negotiation does not return a usable authenticated answer", async (t) => {
  let ctx;
  ctx = await fixture(t, (_req, res) => {
    ctx.store.deleteSession(hashToken(ctx.session.token));
    res.end(JSON.stringify({ answer }));
  });
  assert.equal((await ctx.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) })).status, 401);
});

test("signaling has a per-session negotiation rate bound", async (t) => {
  const ctx = await fixture(t);
  for (let index = 0; index < 12; index++) {
    const response = await ctx.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) });
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  }
  const limited = await ctx.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) });
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "P2P_RATE_LIMITED");
});

test("gateway failures have actionable codes without forwarding private gateway errors", async (t) => {
  for (const [status, code] of [[401, "P2P_GATEWAY_AUTH_FAILED"], [403, "P2P_GATEWAY_AUTH_FAILED"],
    [504, "P2P_ICE_GATHER_TIMEOUT"], [503, "P2P_GATEWAY_BUSY"], [400, "P2P_GATEWAY_REJECTED"], [500, "P2P_GATEWAY_REJECTED"]]) {
    await t.test(String(status), async (t) => {
      const ctx = await fixture(t, (_req, res) => { res.writeHead(status); res.end(`private ${secret} 192.168.1.5 SDP`); });
      const response = await ctx.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) });
      assert.equal(response.status, 503);
      const payload = await response.json();
      assert.deepEqual(Object.keys(payload).sort(), ["code", "error"]);
      assert.equal(payload.code, code);
      assert.match(payload.error, /HTTPS/);
      assert.doesNotMatch(JSON.stringify(payload), /private|192\.168|SDP|test_gateway_secret/);
    });
  }
});

test("malformed and oversized answers are distinguishable from an unreachable gateway", async (t) => {
  for (const body of ["private invalid JSON", JSON.stringify({ answer: { type: "offer", sdp: "v=0" } }), "x".repeat(129 * 1024)]) {
    await t.test(`answer length ${body.length}`, async (t) => {
      const ctx = await fixture(t, (_req, res) => res.end(body));
      const response = await ctx.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, "P2P_GATEWAY_BAD_ANSWER");
    });
  }
  const unreachable = await fixture(t, (req) => req.socket.destroy());
  const response = await unreachable.request("/api/p2p/offer", { method: "POST", body: JSON.stringify({ offer }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "P2P_GATEWAY_UNREACHABLE");
});

test("gateway deadline and user cancellation keep separate diagnostic codes", async (t) => {
  const input = { body: { offer }, session: { token: "session", expires_at: Date.now() + 60_000 }, cookieName: "clip_session", host: "localhost" };
  const signaling = createP2pSignaling({ enabled: true, gatewayUrl: "http://127.0.0.1:8090", secret });
  t.after(() => signaling.close());
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => {
    if (signal.aborted) throw signal.reason;
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  });
  const originalTimeout = AbortSignal.timeout;
  const timeoutMock = t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 10_000);
    return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  });
  await assert.rejects(signaling.offer(input), { status: 503, code: "P2P_GATEWAY_TIMEOUT" });
  timeoutMock.mock.restore();
  assert.equal(AbortSignal.timeout, originalTimeout);
  await assert.rejects(signaling.offer({ ...input, signal: AbortSignal.abort() }), { status: 503, code: "P2P_NEGOTIATION_CANCELLED" });
});
