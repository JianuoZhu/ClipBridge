import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createSession } from "../src/auth.js";
import { createClipServer } from "../src/server.js";
import { Store } from "../src/store.js";

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-stream-test-"));
  const config = {
    dataDir, domain: "", username: "admin", password: "correct-horse-battery-staple",
    retentionHours: 24, maxFileBytes: 4 * 1024 * 1024, maxStorageBytes: 8 * 1024 * 1024,
    maxTextBytes: 1024, sessionDays: 30, cookieSecure: false,
  };
  const store = new Store(dataDir);
  let app;
  t.after(async () => {
    if (app) {
      app.server.closeAllConnections();
      await new Promise((resolve) => app.close(resolve));
    }
    store.close();
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^clip-stream-test-/);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  app = await createClipServer({ config, store });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const session = createSession(store, config.username, config.sessionDays);
  return { base, store, cookie: `clip_session=${session.token}` };
}

async function upload(context, body) {
  const response = await fetch(`${context.base}/api/items/file`, {
    method: "POST",
    headers: { Cookie: context.cookie, "X-Clip-Request": "1", "X-Clip-File-Name": "stream-test.bin" },
    body,
  });
  assert.equal(response.status, 201);
  return (await response.json()).item;
}

async function deadline(promise, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), 3000); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test("short filesystem writes preserve every uploaded byte", { timeout: 10000 }, async (t) => {
  const context = await fixture(t);
  const originalOpen = fs.open;
  const restorations = [];
  let shortWrites = 0;
  fs.open = async function (filePath, flags, ...args) {
    const handle = await originalOpen.call(this, filePath, flags, ...args);
    if (path.dirname(String(filePath)) === context.store.uploadsDir && flags === "wx") {
      const originalWrite = handle.write;
      restorations.push(() => { handle.write = originalWrite; });
      handle.write = async function (buffer, offset = 0, length = buffer.byteLength - offset, position = null) {
        const shortened = Math.min(length, 997);
        if (shortened < length) shortWrites += 1;
        return originalWrite.call(this, buffer, offset, shortened, position);
      };
    }
    return handle;
  };
  try {
    const bytes = Buffer.from(Array.from({ length: 128 * 1024 + 17 }, (_, index) => index % 251));
    const item = await upload(context, bytes);
    assert.ok(shortWrites > 1, "the upload must encounter multiple short writes");
    assert.equal(item.size, bytes.length);
    const saved = context.store.getItem(item.id);
    assert.deepEqual(await fs.readFile(path.join(context.store.blobsDir, saved.blob_name)), bytes);
    const download = await fetch(`${context.base}/api/items/${item.id}/file`, { headers: { Cookie: context.cookie } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
    assert.deepEqual(await fs.readdir(context.store.uploadsDir), []);
  } finally {
    fs.open = originalOpen;
    for (const restore of restorations) restore();
  }
});

test("failed and aborted downloads close file handles and leave the service usable", { timeout: 15000 }, async (t) => {
  const context = await fixture(t);
  const bytes = Buffer.alloc(512 * 1024, "private file bytes");
  const item = await upload(context, bytes);
  const url = `${context.base}/api/items/${item.id}/file`;
  const originalOpen = fs.open;

  for (const mode of ["read-error", "client-abort"]) {
    const opened = [];
    const restorations = [];
    let client;
    fs.open = async function (filePath, flags, ...args) {
      const handle = await originalOpen.call(this, filePath, flags, ...args);
      if (path.dirname(String(filePath)) === context.store.blobsDir && flags === "r") {
        const record = { handle, closed: new Promise((resolve) => handle.once("close", resolve)) };
        opened.push(record);
        const originalCreateReadStream = handle.createReadStream;
        restorations.push(() => { handle.createReadStream = originalCreateReadStream; });
        handle.createReadStream = function (options) {
          const stream = originalCreateReadStream.call(this, { ...options, highWaterMark: 1024 });
          record.stream = stream;
          // Stop after real file data reaches the socket, while the descriptor is still open.
          stream.once("data", () => {
            record.deliveredData = true;
            stream.pause();
            if (mode === "read-error") {
              setImmediate(() => stream.destroy(new Error("Injected asynchronous disk read failure")));
            }
          });
          return stream;
        };
      }
      return handle;
    };
    try {
      if (mode === "read-error") {
        const controller = new AbortController();
        try {
          const failedDownload = (async () => {
            const response = await fetch(url, { headers: { Cookie: context.cookie }, signal: controller.signal });
            await response.arrayBuffer();
          })();
          await assert.rejects(deadline(failedDownload, "read failure did not terminate the response"), (error) => {
            assert.notEqual(error.message, "read failure did not terminate the response");
            return true;
          });
        } finally {
          controller.abort();
        }
      } else {
        await deadline(new Promise((resolve, reject) => {
          client = http.get(url, { headers: { Cookie: context.cookie }, agent: false }, (response) => {
            response.once("error", reject);
            response.once("data", (chunk) => {
              assert.ok(chunk.length > 0);
              response.destroy();
              resolve();
            });
          });
          client.once("error", reject);
        }), "download never delivered its first chunk");
      }
      assert.equal(opened.length, 1, `${mode}: one download descriptor should be opened`);
      const record = opened[0];
      assert.equal(record.deliveredData, true, `${mode}: the download must begin before it fails`);
      await deadline(record.closed, `${mode}: file descriptor was not closed`);
      assert.equal(record.handle.fd, -1, `${mode}: descriptor must be released`);
      assert.equal(record.stream.destroyed, true, `${mode}: source stream must be destroyed`);
      assert.ok(record.stream.bytesRead < bytes.length, `${mode}: failure must occur before the complete file is read`);
    } finally {
      fs.open = originalOpen;
      for (const restore of restorations) restore();
      client?.destroy();
      for (const record of opened) {
        record.stream?.destroy();
        await record.handle.close().catch(() => {});
      }
    }

    const health = await fetch(`${context.base}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: "ok" });
    const recovered = await fetch(url, { headers: { Cookie: context.cookie } });
    assert.equal(recovered.status, 200);
    assert.deepEqual(Buffer.from(await recovered.arrayBuffer()), bytes);
  }
});
