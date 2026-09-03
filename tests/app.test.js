import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { createClipServer } from "../src/server.js";

test("authenticated text and file workflow", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "jianuo-clip-test-"));
  const config = {
    port: 0,
    dataDir,
    domain: "",
    username: "admin",
    password: "correct-horse-battery-staple",
    retentionHours: 24,
    maxFileBytes: 1024 * 1024,
    maxStorageBytes: 10 * 1024 * 1024,
    maxTextBytes: 64 * 1024,
    sessionDays: 30,
    cookieSecure: false,
  };
  const store = new Store(dataDir);
  const app = await createClipServer({ config, store });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const unauthenticated = await fetch(`${base}/api/items`);
  assert.equal(unauthenticated.status, 401);

  const missingRequestMarker = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password: config.password }),
  });
  assert.equal(missingRequestMarker.status, 403);

  const rejected = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Clip-Request": "1" },
    body: JSON.stringify({ username: "admin", password: "wrong-password" }),
  });
  assert.equal(rejected.status, 401);

  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Clip-Request": "1" },
    body: JSON.stringify({ username: "admin", password: config.password }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie").split(";", 1)[0];
  assert.match(cookie, /^clip_session=/);

  const textResponse = await fetch(`${base}/api/items/text`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      "X-Clip-Request": "1",
    },
    body: JSON.stringify({ text: "跨设备测试文本" }),
  });
  assert.equal(textResponse.status, 201);
  const textItem = (await textResponse.json()).item;
  assert.equal(textItem.text, "跨设备测试文本");

  const fileBytes = Buffer.from("private file contents");
  const fileResponse = await fetch(`${base}/api/items/file`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "text/plain",
      "X-Clip-Request": "1",
      "X-Clip-File-Name": encodeURIComponent("测试 file.txt"),
    },
    body: fileBytes,
  });
  assert.equal(fileResponse.status, 201);
  const fileItem = (await fileResponse.json()).item;
  assert.equal(fileItem.fileName, "测试 file.txt");
  assert.equal(fileItem.size, fileBytes.length);

  const listResponse = await fetch(`${base}/api/items`, { headers: { Cookie: cookie } });
  assert.equal(listResponse.status, 200);
  const list = (await listResponse.json()).items;
  assert.equal(list.length, 2);

  const download = await fetch(`${base}/api/items/${fileItem.id}/file`, {
    headers: { Cookie: cookie },
  });
  assert.equal(download.status, 200);
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), fileBytes);
  assert.match(download.headers.get("content-disposition"), /^attachment;/);

  const range = await fetch(`${base}/api/items/${fileItem.id}/file`, {
    headers: { Cookie: cookie, Range: "bytes=0-6" },
  });
  assert.equal(range.status, 206);
  assert.equal(await range.text(), "private");

  const deletion = await fetch(`${base}/api/items/${textItem.id}`, {
    method: "DELETE",
    headers: { Cookie: cookie, "X-Clip-Request": "1" },
  });
  assert.equal(deletion.status, 204);
});
