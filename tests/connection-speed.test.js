import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { deflateSync } from "node:zlib";
import { createSession, hashToken } from "../src/auth.js";
import { loadConfig } from "../src/config.js";
import { createClipServer } from "../src/server.js";
import { createConnectionSpeed, maxSpeedBytes } from "../src/connection-speed.js";
import { Store } from "../src/store.js";
import { listenOnLoopback } from "./support/listen.js";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-speed-test-"));
  const config = loadConfig({ CLIP_DATA_DIR: dataDir, CLIP_COOKIE_SECURE: "false" });
  const store = new Store(dataDir);
  const app = await createClipServer({ config, store });
  await listenOnLoopback(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = createSession(store, "member", 1);
  const cookie = `clip_session=${session.token}`;
  const request = (url, options = {}) => fetch(base + url, {
    ...options, headers: { Cookie: cookie, "X-Clip-Request": "1", ...options.headers },
    signal: options.signal || AbortSignal.timeout(5000),
  });
  t.after(async () => {
    app.server.closeAllConnections();
    await new Promise((resolve) => app.close(resolve));
    store.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^clip-speed-test-/);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { ...app, base, request, store, session, cookie };
}

async function heldUpload(ctx, { cookie = ctx.cookie, bytes = 8, chunked = false } = {}) {
  const started = new Promise((resolve) => ctx.server.once("request", (incoming) => setImmediate(() => resolve(incoming))));
  let req;
  const response = new Promise((resolve) => {
    req = http.request(`${ctx.base}/api/connection/speed?bytes=${bytes}`, {
      method: "POST", headers: { Cookie: cookie, "X-Clip-Request": "1",
        ...(chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": bytes }) },
    }, async (res) => {
      const chunks = [];
      for await (const chunk of res) chunks.push(chunk);
      resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() });
    });
    req.on("error", () => resolve({ status: 0 }));
    req.write(Buffer.alloc(1));
  });
  const incoming = await started;
  return { req, response, incoming };
}

test("speed probes require login and upload probes require the existing origin checks", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await fetch(ctx.base + "/api/connection/speed?bytes=1")).status, 401);
  assert.equal((await fetch(ctx.base + "/api/connection/speed?bytes=1", {
    method: "POST", headers: { "X-Clip-Request": "1" }, body: "a",
  })).status, 401);
  assert.equal((await ctx.request("/api/connection/speed?bytes=1", {
    method: "POST", headers: { "X-Clip-Request": "" }, body: "a",
  })).status, 403);
  assert.equal((await ctx.request("/api/connection/speed?bytes=1", {
    method: "POST", headers: { Origin: "https://evil.example" }, body: "a",
  })).status, 403);
});

test("speed probes strictly validate sizes and reject compressed or mismatched uploads", async (t) => {
  const ctx = await fixture(t);
  for (const query of ["", "bytes=0", "bytes=-1", "bytes=1.5", "bytes=01", "bytes=1e3", "bytes=1&bytes=2", "bytes=99999999999999999"]) {
    assert.equal((await ctx.request(`/api/connection/speed?${query}`)).status, 400, query);
  }
  assert.equal((await ctx.request(`/api/connection/speed?bytes=${maxSpeedBytes + 1}`)).status, 413);
  assert.equal((await ctx.request("/api/connection/speed?bytes=3", { method: "POST", body: "ab" })).status, 400);
  assert.equal((await ctx.request("/api/connection/speed?bytes=1", {
    method: "POST", body: "a", headers: { "Content-Encoding": "gzip" },
  })).status, 415);
  assert.equal((await ctx.request("/api/connection/speed?bytes=1", { headers: { "Content-Encoding": "br" } })).status, 415);
  assert.equal((await ctx.request("/api/connection/speed?bytes=1", { method: "DELETE" })).status, 404);
  assert.equal((await ctx.request("/api/connection/speed/extra?bytes=1")).status, 404);
  const short = await heldUpload(ctx, { chunked: true });
  short.req.end("ab");
  assert.equal((await short.response).status, 400);
  const long = await heldUpload(ctx, { bytes: 2, chunked: true });
  long.req.end("ab");
  assert.equal((await long.response).status, 413);
});

test("speed transfers use exact uncached random bytes and do not persist items or files", async (t) => {
  const ctx = await fixture(t);
  const before = {
    items: ctx.store.listItems(Date.now()), library: ctx.store.listLibraryFiles(),
    blobs: await fs.readdir(ctx.store.blobsDir), uploads: await fs.readdir(ctx.store.uploadsDir),
  };
  const response = await ctx.request(`/api/connection/speed?bytes=${maxSpeedBytes}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-length"), String(maxSpeedBytes));
  assert.equal(response.headers.get("content-type"), "application/octet-stream");
  assert.match(response.headers.get("cache-control"), /no-store.*no-transform/);
  const downloaded = Buffer.from(await response.arrayBuffer());
  assert.equal(downloaded.length, maxSpeedBytes);
  assert.ok(deflateSync(downloaded).length > maxSpeedBytes * 0.99);
  const next = Buffer.from(await ctx.request(`/api/connection/speed?bytes=${maxSpeedBytes}`).then((r) => r.arrayBuffer()));
  assert.notDeepEqual(downloaded.subarray(0, 64), next.subarray(0, 64));
  const uploaded = await ctx.request(`/api/connection/speed?bytes=${maxSpeedBytes}`, {
    method: "POST", body: downloaded, headers: { "Content-Type": "application/octet-stream", "Content-Encoding": "identity" },
  });
  assert.equal(uploaded.status, 200);
  assert.match(uploaded.headers.get("cache-control"), /no-store.*no-transform/);
  assert.deepEqual(await uploaded.json(), { bytes: maxSpeedBytes });
  assert.deepEqual(ctx.store.listItems(Date.now()), before.items);
  assert.deepEqual(ctx.store.listLibraryFiles(), before.library);
  assert.deepEqual(await fs.readdir(ctx.store.blobsDir), before.blobs);
  assert.deepEqual(await fs.readdir(ctx.store.uploadsDir), before.uploads);
});

test("logout during an upload cannot produce a successful speed acknowledgement", async (t) => {
  const ctx = await fixture(t);
  const upload = await heldUpload(ctx);
  ctx.store.deleteSession(hashToken(ctx.session.token));
  upload.req.end(Buffer.alloc(7));
  assert.equal((await upload.response).status, 401);
});

test("speed concurrency is limited per session and globally, and cancellation releases slots", async (t) => {
  const ctx = await fixture(t);
  const uploads = [await heldUpload(ctx)];
  t.after(() => uploads.forEach(({ req }) => req.destroy()));
  assert.equal((await ctx.request("/api/connection/speed?bytes=1")).status, 429);
  for (let index = 0; index < 7; index++) {
    const session = createSession(ctx.store, "member", 1);
    uploads.push(await heldUpload(ctx, { cookie: `clip_session=${session.token}` }));
  }
  const spare = createSession(ctx.store, "member", 1);
  assert.equal((await ctx.request("/api/connection/speed?bytes=1", { headers: { Cookie: `clip_session=${spare.token}` } })).status, 429);
  const closed = uploads.map(({ incoming }) => new Promise((resolve) => incoming.once("close", resolve)));
  uploads.forEach(({ req }) => req.destroy());
  await Promise.all([...closed, ...uploads.map(({ response }) => response)]);
  const next = await ctx.request("/api/connection/speed?bytes=1");
  assert.equal(next.status, 200);
  await next.arrayBuffer();
});

test("a stalled speed upload times out and releases its concurrency slot", async (t) => {
  const speed = createConnectionSpeed({ timeoutMs: 30, maxActive: 1 });
  const server = http.createServer((request, response) => {
    speed.transfer(request, response, new URL(request.url, "http://local"), { token: "test" }, () => {}).catch((error) => {
      if (response.destroyed) return;
      if (response.headersSent) return response.destroy();
      response.setHeader("Connection", "close");
      request.resume();
      response.writeHead(error.status || 500);
      response.end(error.message);
    });
  });
  await listenOnLoopback(server);
  const ctx = { server, base: `http://127.0.0.1:${server.address().port}`, cookie: "test" };
  t.after(async () => {
    speed.close(); server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const upload = await heldUpload(ctx);
  assert.equal((await upload.response).status, 408);
  const response = await fetch(ctx.base + "/api/connection/speed?bytes=1");
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 1);
});
