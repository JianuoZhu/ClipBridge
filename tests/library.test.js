import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { createClipServer } from "../src/server.js";
import { listenOnLoopback } from "./support/listen.js";

async function fixture(t, overrides = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-library-"));
  const config = { dataDir, pin: "1223", username: "admin", password: "correct-horse-battery-staple", domain: "",
    retentionHours: 24, maxFileBytes: 1024, maxTextBytes: 512, maxStorageBytes: 2048, sessionDays: 30, cookieSecure: false, ...overrides };
  let store;
  let app;
  let base;
  async function start() {
    store = new Store(dataDir);
    app = await createClipServer({ config, store });
    await listenOnLoopback(app.server);
    base = `http://127.0.0.1:${app.server.address().port}`;
  }
  async function stop() {
    await new Promise((resolve) => app.close(resolve));
    store.close();
  }
  await start();
  t.after(async () => {
    await stop();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^clip-library-/);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  const request = (url, options = {}) => fetch(base + url, { signal: AbortSignal.timeout(5000), ...options });
  const login = async (admin = false) => {
    const response = await request(admin ? "/api/auth/admin" : "/api/auth/login", {
      method: "POST", headers: { "X-Clip-Request": "1" }, body: JSON.stringify(admin ? { username: config.username, password: config.password } : { pin: config.pin }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).role, admin ? "admin" : "member");
    return { Cookie: response.headers.get("set-cookie").split(";", 1)[0], "X-Clip-Request": "1" };
  };
  const upload = (headers, name = "notes.txt", body = "私密文件", endpoint = "/api/library") => request(endpoint, {
    method: "POST", headers: { ...headers, "X-Clip-File-Name": encodeURIComponent(name) }, body,
  });
  const patch = (headers, file, changes = {}) => request(`/api/library/${file.id}`, {
    method: "PATCH", headers, body: JSON.stringify({ revision: file.revision, fileName: file.fileName, ...changes }),
  });
  return { request, login, upload, patch, config, get store() { return store; }, get base() { return base; }, restart: async () => { await stop(); await start(); } };
}

test("PIN grants shared access but every library route requires an admin role", async (t) => {
  const f = await fixture(t);
  const member = await f.login();
  const admin = await f.login(true);
  const file = (await (await f.upload(admin)).json()).file;
  assert.equal((await f.request("/api/items", { headers: member })).status, 200);
  for (const [method, endpoint] of [["GET", "/api/library"], ["POST", "/api/library"], ["GET", `/api/library/${file.id}`],
    ["GET", `/api/library/${file.id}/content`], ["GET", `/api/library/${file.id}/file`], ["HEAD", `/api/library/${file.id}/file`],
    ["GET", `/api/library/${file.id}/preview`], ["PATCH", `/api/library/${file.id}`], ["DELETE", `/api/library/${file.id}`]]) {
    assert.equal((await f.request(endpoint, { method })).status, 401, `${method} anonymous ${endpoint}`);
    assert.equal((await f.request(endpoint, { method, headers: member })).status, 403, `${method} member ${endpoint}`);
  }
  assert.equal((await f.request(`/api/items/${file.id}/file`, { headers: member })).status, 404);
  assert.equal((await f.request(`/api/items/${file.id}`, { method: "DELETE", headers: member })).status, 404);
  const shared = await (await f.request("/api/items", { headers: member })).json();
  assert.deepEqual(shared, { items: [], latest: [] });
  const forged = await f.request("/api/auth/login", { method: "POST", headers: member, body: JSON.stringify({ pin: "1223", role: "admin", username: "admin" }) });
  assert.equal((await forged.json()).role, "member");
  assert.equal((await f.request("/api/library", { method: "POST", headers: { Cookie: admin.Cookie }, body: "x" })).status, 403);
});

test("library files survive expiry and restart; editing is atomic and rejects stale saves", async (t) => {
  const f = await fixture(t);
  const admin = await f.login(true);
  const original = (await (await f.upload(admin)).json()).file;
  const content = await (await f.request(`/api/library/${original.id}/content`, { headers: admin })).json();
  assert.equal(content.text, "私密文件");
  const saved = await f.patch(admin, original, { fileName: "重要.md", text: "新版内容\n<script>alert(1)</script>" });
  assert.equal(saved.status, 200);
  const file = (await saved.json()).file;
  assert.equal(file.revision, 2);
  assert.equal((await f.patch(admin, original, { text: "stale overwrite" })).status, 409);
  assert.equal((await f.patch(admin, file, { fileName: "../escape.txt" })).status, 400);
  f.store.cleanup(Date.now() + 25 * 60 * 60 * 1000);
  await f.restart();
  const download = await f.request(`/api/library/${file.id}/file`, { headers: admin });
  assert.equal(download.status, 200);
  assert.match(download.headers.get("content-disposition"), /^attachment/);
  assert.equal(await download.text(), "新版内容\n<script>alert(1)</script>");
  assert.equal((await (await f.request("/api/library", { headers: admin })).json()).files[0].fileName, "重要.md");
  assert.equal((await fs.readdir(f.store.blobsDir)).length, 1);
  const empty = (await (await f.patch(admin, file, { text: "" })).json()).file;
  assert.equal(empty.size, 0);
  assert.equal(await (await f.request(`/api/library/${file.id}/content`, { headers: admin })).json().then((body) => body.text), "");
  const deleted = await f.request(`/api/library/${file.id}`, { method: "DELETE", headers: admin, body: JSON.stringify({ revision: empty.revision }) });
  assert.equal(deleted.status, 204);
  assert.equal((await fs.readdir(f.store.blobsDir)).length, 0);
});

test("preview checks image signatures and UTF-8; shared and library uploads share quota", async (t) => {
  const f = await fixture(t, { maxStorageBytes: 64 });
  const admin = await f.login(true);
  const uploadFile = async (name, bytes) => (await (await f.upload(admin, name, bytes)).json()).file;
  const fake = await uploadFile("fake.png", "<html>bad</html>");
  assert.equal((await f.request(`/api/library/${fake.id}/preview`, { headers: admin })).status, 415);
  const png = await uploadFile("image.png", Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]));
  const preview = await f.request(`/api/library/${png.id}/preview`, { headers: admin });
  assert.equal(preview.status, 200);
  assert.equal(preview.headers.get("content-type"), "image/png");
  const invalid = await uploadFile("bad.txt", Buffer.from([255, 0]));
  assert.equal((await f.request(`/api/library/${invalid.id}/content`, { headers: admin })).status, 415);
  const notes = await uploadFile("a.txt", "small");
  assert.equal((await f.patch(admin, notes, { text: "x".repeat(60) })).status, 507);
  assert.equal((await f.upload(admin, "large.bin", "x".repeat(40), "/api/items/file")).status, 507);
  assert.equal((await fs.readdir(f.store.blobsDir)).length, 4);
  assert.deepEqual(await fs.readdir(f.store.uploadsDir), []);
});

test("shared and library PDF previews are authenticated, validated, and range-capable", async (t) => {
  const f = await fixture(t, { maxFileBytes: 4096, maxStorageBytes: 8192 });
  const member = await f.login();
  const admin = await f.login(true);
  const pdfBytes = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
  const sharedResponse = await f.upload(member, "manual.pdf", pdfBytes, "/api/items/file");
  assert.equal(sharedResponse.status, 201);
  const shared = (await sharedResponse.json()).item;
  assert.equal(shared.previewType, "pdf");
  assert.equal((await f.request(`/api/items/${shared.id}/preview`)).status, 401);
  const range = await f.request(`/api/items/${shared.id}/preview`, { headers: { ...member, Range: "bytes=0-7" } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get("content-type"), "application/pdf");
  assert.equal(range.headers.get("content-range"), `bytes 0-7/${pdfBytes.length}`);
  assert.equal(range.headers.get("cache-control"), "private, no-store");
  assert.equal((await range.arrayBuffer()).byteLength, 8);
  const head = await f.request(`/api/items/${shared.id}/preview`, { method: "HEAD", headers: member });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("accept-ranges"), "bytes");

  const library = (await (await f.upload(admin, "archive.pdf", pdfBytes)).json()).file;
  assert.equal(library.previewType, "pdf");
  assert.equal((await f.request(`/api/library/${library.id}/preview`, { headers: member })).status, 403);
  assert.equal((await f.request(`/api/library/${library.id}/preview`, { headers: admin })).headers.get("content-type"), "application/pdf");

  const fake = (await (await f.upload(member, "fake.pdf", "not a pdf", "/api/items/file")).json()).item;
  assert.equal(fake.previewType, "pdf");
  assert.equal((await f.request(`/api/items/${fake.id}/preview`, { headers: member })).status, 415);
});

test("PIN and admin credentials revoke old sessions on change and disabled admin cannot log in", async (t) => {
  const f = await fixture(t);
  const member = await f.login();
  const admin = await f.login(true);
  await f.restart();
  assert.equal((await f.request("/api/items", { headers: member })).status, 200);
  f.config.pin = "0012";
  await f.restart();
  for (const headers of [member, admin]) assert.equal((await f.request("/api/items", { headers })).status, 401);
  const newMember = await f.login();
  f.config.password = "";
  await f.restart();
  assert.equal((await f.request("/api/items", { headers: newMember })).status, 401);
  const disabled = await f.request("/api/auth/admin", { method: "POST", headers: { "X-Clip-Request": "1" }, body: '{"username":"admin","password":""}' });
  assert.equal(disabled.status, 401);
  assert.equal((await (await f.request("/api/session")).json()).adminEnabled, false);
  await f.login();
});

test("PIN checks are exact and throttled after five failed attempts", async (t) => {
  const f = await fixture(t);
  for (const pin of [1223, "1223 ", "01223", "", "9999"]) {
    const result = await f.request("/api/auth/login", { method: "POST", headers: { "X-Clip-Request": "1" }, body: JSON.stringify({ pin }) });
    assert.equal(result.status, 401);
  }
  assert.equal((await f.request("/api/auth/login", { method: "POST", headers: { "X-Clip-Request": "1" }, body: '{"pin":"1223"}' })).status, 429);
  await f.login(true);
});

test("latest text and file are independent of the 100-item history limit and break timestamp ties", async (t) => {
  const f = await fixture(t);
  const member = await f.login();
  const now = Date.now();
  f.store.createItem({ id: "old-file", kind: "file", fileName: "old.bin", size: 1, createdAt: now - 1, expiresAt: now + 10000 });
  for (let i = 0; i < 101; i++) f.store.createItem({ id: `text-${i}`, kind: "text", textContent: `text-${i}`, size: 1, createdAt: now, expiresAt: now + 10000 });
  const payload = await (await f.request("/api/items", { headers: member })).json();
  assert.equal(payload.items.length, 100);
  assert.equal(payload.latest.find((item) => item.kind === "file").id, "old-file");
  assert.equal(payload.latest.find((item) => item.kind === "text").id, "text-100");
});

test("logout during a library upload rejects the commit and removes temporary data", async (t) => {
  const f = await fixture(t);
  const admin = await f.login(true);
  let uploading;
  const completed = new Promise((resolve, reject) => {
    uploading = http.request(f.base + "/api/library", { method: "POST", headers: { ...admin, "X-Clip-File-Name": "pending.txt" } }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    uploading.on("error", reject);
    uploading.setTimeout(5000, () => uploading.destroy(new Error("timeout")));
  });
  uploading.write("pending");
  await f.request("/api/auth/logout", { method: "POST", headers: admin });
  uploading.end(" data");
  assert.equal(await completed, 401);
  assert.equal(f.store.listLibraryFiles().length, 0);
  assert.deepEqual(await fs.readdir(f.store.blobsDir), []);
  assert.deepEqual(await fs.readdir(f.store.uploadsDir), []);
});
