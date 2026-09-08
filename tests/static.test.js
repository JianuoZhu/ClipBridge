import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Store } from "../src/store.js";
import { createClipServer } from "../src/server.js";
import { listenOnLoopback } from "./support/listen.js";

test("production shell uses per-response CSP nonces and safe cache boundaries", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clipbridge-static-test-"));
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
  await listenOnLoopback(app.server);
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await new Promise((resolve) => app.close(resolve));
    store.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  const first = await fetch(`${base}/`);
  const firstHtml = await first.text();
  const nonce = /<meta name="csp-nonce" content="([^"]+)">/.exec(firstHtml)?.[1];
  const csp = first.headers.get("content-security-policy") || "";
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.ok(nonce);
  assert.match(csp, new RegExp(`script-src 'self' 'wasm-unsafe-eval'`));
  assert.match(csp, /script-src-attr 'none'/);
  assert.match(csp, new RegExp(`style-src 'self' 'nonce-${nonce}'`));
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(firstHtml, /__CSP_NONCE__/);

  const secondHtml = await (await fetch(`${base}/`)).text();
  const secondNonce = /<meta name="csp-nonce" content="([^"]+)">/.exec(secondHtml)?.[1];
  assert.notEqual(secondNonce, nonce);

  const assetPath = /src="(\/assets\/[^"]+\.js)"/.exec(firstHtml)?.[1];
  assert.ok(assetPath);
  const asset = await fetch(`${base}${assetPath}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const sourceMap = await fetch(`${base}${assetPath}.map`);
  assert.equal(sourceMap.status, 404);
  assert.match(sourceMap.headers.get("content-type") || "", /^application\/json/);

  const missingApi = await fetch(`${base}/api/not-a-route`);
  assert.equal(missingApi.status, 404);
  assert.deepEqual(await missingApi.json(), { error: "未找到" });
});
