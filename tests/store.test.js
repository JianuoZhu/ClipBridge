import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPasswordVerifier, createSession, hashToken } from "../src/auth.js";
import { Store } from "../src/store.js";

const username = "admin";
const password = "correct-horse-battery-staple";

async function temporaryData(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "clip-store-test-"));
  t.after(async () => {
    assert.equal(path.dirname(dataDir), path.resolve(os.tmpdir()));
    assert.match(path.basename(dataDir), /^clip-store-test-/);
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return dataDir;
}

test("an existing database gains credential binding without losing shared items", async (t) => {
  const dataDir = await temporaryData(t);
  const legacy = new DatabaseSync(path.join(dataDir, "clip.db"));
  legacy.exec(`
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY, username TEXT NOT NULL,
      created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE items (
      id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('text', 'file')),
      text_content TEXT, file_name TEXT, mime_type TEXT, blob_name TEXT,
      size INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
    ) STRICT;
    INSERT INTO sessions VALUES ('legacy-token-hash', 'admin', 0, 9000000000000);
    INSERT INTO items VALUES ('saved-text', 'text', 'Keep this text', NULL, NULL, NULL, 14, 0, 9000000000000);
  `);
  legacy.close();
  const store = new Store(dataDir);
  try {
    assert.ok(store.findSession("legacy-token-hash", Date.now()));
    await createPasswordVerifier(password, { store, username });
    assert.equal(store.findSession("legacy-token-hash", Date.now()), undefined);
    assert.equal(store.getItem("saved-text").text_content, "Keep this text");
    const state = store.getCredentialState();
    assert.equal(state.username, username);
    assert.match(state.salt, /^[0-9a-f]{32}$/);
    assert.match(state.passwordHash, /^[0-9a-f]{64}$/);
    assert.notEqual(state.passwordHash, password);
  } finally {
    store.close();
  }
});

test("sessions survive restarts with matching credentials and expire after account or password changes", async (t) => {
  const dataDir = await temporaryData(t);
  let store = new Store(dataDir);
  try {
    await createPasswordVerifier(password, { store, username });
    const session = createSession(store, username, 30);
    const tokenHash = hashToken(session.token);
    assert.ok(store.findSession(tokenHash, Date.now()));
    assert.equal(store.findSession(session.token, Date.now()), undefined);
    const initialState = store.getCredentialState();
    store.close();
    store = new Store(dataDir);
    await createPasswordVerifier(password, { store, username });
    assert.ok(store.findSession(tokenHash, Date.now()));
    assert.deepEqual(store.getCredentialState(), initialState);

    await createPasswordVerifier("a-different-long-password", { store, username });
    assert.equal(store.findSession(tokenHash, Date.now()), undefined);
    const nextSession = createSession(store, username, 30);
    await createPasswordVerifier("a-different-long-password", { store, username: "renamed-user" });
    assert.equal(store.findSession(hashToken(nextSession.token), Date.now()), undefined);
  } finally {
    store.close();
  }
});

test("credential updates roll back session revocation if metadata cannot be saved", async (t) => {
  const store = new Store(await temporaryData(t));
  try {
    await createPasswordVerifier(password, { store, username });
    const before = store.getCredentialState();
    const session = createSession(store, username, 30);
    assert.throws(() => store.syncCredentials(null, before.salt, before.passwordHash));
    assert.ok(store.findSession(hashToken(session.token), Date.now()));
    assert.deepEqual(store.getCredentialState(), before);
  } finally {
    store.close();
  }
});

test("expiry boundaries hide sessions and remove only expired item records", async (t) => {
  const store = new Store(await temporaryData(t));
  try {
    store.createSession("expired-session", username, 0, 100);
    store.createSession("live-session", username, 0, 101);
    for (const [id, expiresAt] of [["expired-file", 100], ["live-file", 101]]) {
      store.createItem({
        id, kind: "file", fileName: `${id}.txt`, mimeType: "text/plain", blobName: id,
        size: 10, createdAt: 0, expiresAt,
      });
    }
    assert.equal(store.findSession("expired-session", 100), undefined);
    assert.ok(store.findSession("live-session", 100));
    assert.equal(store.usedFileBytes(100), 10);
    assert.deepEqual(store.listItems(100).map((item) => item.id), ["live-file"]);
    const expired = store.cleanup(100);
    assert.deepEqual(expired.map((item) => item.blob_name), ["expired-file"]);
    assert.equal(store.getItem("expired-file"), undefined);
    assert.ok(store.getItem("live-file"));
    assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count, 1);
  } finally {
    store.close();
  }
});
