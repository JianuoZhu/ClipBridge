import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/store.js";
import { createClipServer } from "../src/server.js";
import { listenOnLoopback } from "./support/listen.js";

async function start(t, overrides = {}, seed) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-regression-"));
  const config = {
    dataDir, domain: "", username: "admin", password: "correct-horse-battery-staple",
    retentionHours: 24, maxFileBytes: 1024, maxStorageBytes: 2048,
    maxTextBytes: 1024, sessionDays: 30, cookieSecure: false, ...overrides,
  };
  const store = new Store(dataDir);
  await seed?.(store);
  const app = await createClipServer({ config, store });
  await listenOnLoopback(app.server);
  const base = `http://127.0.0.1:${app.server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = (url, options = {}) => fetch(base + url, {
    signal: AbortSignal.timeout(5000), ...options,
  });
  const login = await request("/api/auth/admin", {
    method: "POST", headers: { "X-Clip-Request": "1" },
    body: JSON.stringify({ username: config.username, password: config.password }),
  });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.get("set-cookie").split(";", 1)[0], "X-Clip-Request": "1" };
  await login.arrayBuffer();
  const upload = (body, extraHeaders = {}) => request("/api/items/file", {
    method: "POST", headers: { ...headers, ...extraHeaders }, body,
  });
  return { request, upload, headers, store, config, base };
}

test("rejects non-object JSON and validates the complete Origin", async (t) => {
  const { request, headers, base } = await start(t);
  for (const endpoint of ["/api/auth/login", "/api/items/text"]) {
    for (const body of ["null", "[]", '"text"', "1", "{"]) {
      const response = await request(endpoint, { method: "POST", headers, body });
      assert.equal(response.status, 400, `${endpoint}: ${body}`);
      assert.match((await response.json()).error, /JSON/);
    }
  }
  for (const origin of [base.replace("http:", "https:"), "null", `${base}/path`, "https://example.com"]) {
    const response = await request("/api/items/text", {
      method: "POST", headers: { ...headers, Origin: origin }, body: '{"text":"x"}',
    });
    assert.equal(response.status, 403, origin);
  }
  const allowed = await request("/api/items/text", {
    method: "POST", headers: { ...headers, Origin: base }, body: '{"text":"x"}',
  });
  assert.equal(allowed.status, 201);
});

test("text limits measure decoded UTF-8 bytes and allow JSON escaping", async (t) => {
  const { request, headers } = await start(t);
  const accepted = await request("/api/items/text", {
    method: "POST", headers, body: `{"text":"${"\\u0000".repeat(1024)}"}`,
  });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json()).item.size, 1024);
  const tooLarge = await request("/api/items/text", {
    method: "POST", headers, body: JSON.stringify({ text: "中".repeat(342) }),
  });
  assert.equal(tooLarge.status, 413);
  const session = await request("/api/session", { headers });
  assert.equal((await session.json()).settings.maxTextBytes, 1024);
});

test("oversized chunked requests return errors and remove partial files", async (t) => {
  const { request, upload, base, headers, store } = await start(t, { maxFileBytes: 32 });
  const oversized = await upload(Buffer.alloc(33));
  assert.equal(oversized.status, 413);
  const chunked = streamedRequest(base, headers);
  chunked.request.end(Buffer.alloc(33));
  assert.equal((await chunked.result).status, 413);
  const json = await request("/api/items/text", {
    method: "POST", headers, duplex: "half",
    body: (async function* () { yield Buffer.alloc(8 * 1024, 32); })(),
  });
  assert.equal(json.status, 413);
  assert.equal((await upload(Buffer.alloc(0))).status, 400);
  assert.deepEqual(await fs.readdir(store.uploadsDir), []);
  assert.deepEqual(await fs.readdir(store.blobsDir), []);
  assert.equal((await upload(Buffer.from("valid"))).status, 201);
});

function streamedRequest(base, headers, pathname = "/api/items/file") {
  let request;
  const result = new Promise((resolve, reject) => {
    request = http.request(base + pathname, { method: "POST", headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }));
      response.on("error", reject);
    });
    request.on("error", reject);
    request.setTimeout(5000, () => request.destroy(new Error("Request timed out")));
  });
  return { request, result };
}

test("concurrent uploads reserve capacity while streaming and release rejected uploads", async (t) => {
  const { base, headers, upload, store } = await start(t, { maxStorageBytes: 8 });
  const first = streamedRequest(base, headers);
  t.after(() => first.request.destroy());
  first.request.write(Buffer.from("123456"));
  const deadline = Date.now() + 3000;
  while (true) {
    const entries = await fs.readdir(store.uploadsDir);
    if (entries.length && (await fs.stat(path.join(store.uploadsDir, entries[0]))).size === 6) break;
    assert.ok(Date.now() < deadline, "first upload did not reach disk");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const second = streamedRequest(base, headers);
  second.request.end("abc");
  assert.equal((await second.result).status, 507);
  first.request.end();
  assert.equal((await first.result).status, 201);
  const last = await upload(Buffer.from("xy"));
  assert.equal(last.status, 201);
  assert.equal(store.usedFileBytes(Date.now()), 8);
  assert.deepEqual(await fs.readdir(store.uploadsDir), []);
  assert.equal((await fs.readdir(store.blobsDir)).length, 2);
});

test("logout revokes a text request that is still receiving its body", async (t) => {
  const { base, request, headers, store } = await start(t);
  const pending = streamedRequest(base, headers, "/api/items/text");
  pending.request.write('{"text":"');
  // An independent request can finish while the body above is still incomplete.
  assert.equal((await request("/api/auth/logout", { method: "POST", headers })).status, 204);
  pending.request.end('late text"}');
  assert.equal((await pending.result).status, 401);
  assert.equal(store.listItems(Date.now()).length, 0);
});

test("download handles Unicode file names, HEAD, suffix ranges and missing blobs", async (t) => {
  const { request, upload, headers, store } = await start(t);
  const fileName = `${"a".repeat(239)}😀.txt`;
  const response = await upload(Buffer.from("0123456789"), {
    "X-Clip-File-Name": encodeURIComponent(`../../${fileName}`),
  });
  assert.equal(response.status, 201);
  const { item } = await response.json();
  const url = `/api/items/${item.id}/file`;
  const full = await request(url, { headers });
  assert.equal(full.status, 200);
  assert.equal(await full.text(), "0123456789");
  assert.ok(full.headers.get("content-disposition").includes(encodeURIComponent("😀")));
  const head = await request(url, { method: "HEAD", headers });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), "10");
  assert.equal(await head.text(), "");
  for (const [range, content] of [["bytes=-3", "789"], ["bytes=7-", "789"], ["bytes=7-99", "789"]]) {
    const partial = await request(url, { headers: { ...headers, Range: range } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), content);
  }
  for (const range of ["bytes=10-", "bytes=-0", "bytes=3-2", "bytes=0-1,3-4", "bytes=9007199254740992-"]) {
    const invalid = await request(url, { headers: { ...headers, Range: range } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */10");
  }
  await fs.unlink(path.join(store.blobsDir, store.getItem(item.id).blob_name));
  assert.equal((await request(url, { headers })).status, 404);
  assert.equal((await request("/healthz")).status, 200);
});

test("SSE delivers changes after request completion and closes on logout", async (t) => {
  const { request, headers } = await start(t);
  const response = await request("/api/events", { headers });
  const reader = response.body.getReader();
  t.after(() => reader.cancel().catch(() => {}));
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: ready/);
  await request("/api/items/text", { method: "POST", headers, body: '{"text":"event"}' });
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: items/);
  const logout = await request("/api/auth/logout", { method: "POST", headers });
  assert.equal(logout.status, 204);
  assert.match(new TextDecoder().decode((await reader.read()).value), /event: session-expired/);
  assert.equal((await reader.read()).done, true);
  assert.equal((await request("/api/items", { headers })).status, 401);
});

test("startup removes expired and orphan blobs while preserving live items", async (t) => {
  const liveBlob = randomUUID();
  const { store } = await start(t, {}, async (store) => {
    const now = Date.now();
    for (const [blob, expiresAt] of [[liveBlob, now + 60_000], [randomUUID(), now - 1]]) {
      await fs.writeFile(path.join(store.blobsDir, blob), "data");
      store.createItem({ id: randomUUID(), kind: "file", blobName: blob, size: 4, createdAt: now, expiresAt });
    }
    await fs.writeFile(path.join(store.blobsDir, randomUUID()), "orphan");
    await fs.writeFile(path.join(store.uploadsDir, `${randomUUID()}.part`), "partial");
    await fs.writeFile(path.join(store.blobsDir, "unmanaged.txt"), "leave alone");
  });
  assert.deepEqual((await fs.readdir(store.blobsDir)).sort(), [liveBlob, "unmanaged.txt"].sort());
  assert.deepEqual(await fs.readdir(store.uploadsDir), []);
  assert.equal(store.listItems(Date.now()).length, 1);
});
