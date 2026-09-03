import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class Store {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.blobsDir = path.join(dataDir, "blobs");
    this.uploadsDir = path.join(dataDir, "uploads");
    fs.mkdirSync(this.blobsDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.uploadsDir, { recursive: true, mode: 0o700 });

    this.db = new DatabaseSync(path.join(dataDir, "clip.db"));
    this.db.exec("PRAGMA journal_mode=WAL");
    this.db.exec("PRAGMA foreign_keys=ON");
    this.db.exec("PRAGMA busy_timeout=5000");
    this.db.exec("PRAGMA secure_delete=FAST");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at
        ON sessions(expires_at);

      CREATE TABLE IF NOT EXISTS items (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK (kind IN ('text', 'file')),
        text_content TEXT,
        file_name TEXT,
        mime_type TEXT,
        blob_name TEXT,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_items_created_at
        ON items(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_items_expires_at
        ON items(expires_at);
    `);
    this.db.exec("PRAGMA optimize");

    this.insertSessionStatement = this.db.prepare(
      "INSERT INTO sessions(token_hash, username, created_at, expires_at) VALUES (?, ?, ?, ?)"
    );
    this.findSessionStatement = this.db.prepare(
      "SELECT username, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?"
    );
    this.deleteSessionStatement = this.db.prepare("DELETE FROM sessions WHERE token_hash = ?");
    this.insertItemStatement = this.db.prepare(`
      INSERT INTO items(id, kind, text_content, file_name, mime_type, blob_name, size, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    this.getItemStatement = this.db.prepare("SELECT * FROM items WHERE id = ?");
    this.listItemsStatement = this.db.prepare(
      "SELECT * FROM items WHERE expires_at > ? ORDER BY created_at DESC LIMIT ?"
    );
    this.deleteItemStatement = this.db.prepare("DELETE FROM items WHERE id = ? RETURNING *");
    this.expiredItemsStatement = this.db.prepare(
      "SELECT id, blob_name FROM items WHERE expires_at <= ?"
    );
    this.deleteExpiredItemsStatement = this.db.prepare("DELETE FROM items WHERE expires_at <= ?");
    this.usedFileBytesStatement = this.db.prepare(
      "SELECT COALESCE(SUM(size), 0) AS bytes FROM items WHERE kind = 'file' AND expires_at > ?"
    );
  }

  createSession(tokenHash, username, createdAt, expiresAt) {
    this.insertSessionStatement.run(tokenHash, username, createdAt, expiresAt);
  }

  findSession(tokenHash, now) {
    return this.findSessionStatement.get(tokenHash, now);
  }

  deleteSession(tokenHash) {
    this.deleteSessionStatement.run(tokenHash);
  }

  createItem(item) {
    this.insertItemStatement.run(
      item.id,
      item.kind,
      item.textContent ?? null,
      item.fileName ?? null,
      item.mimeType ?? null,
      item.blobName ?? null,
      item.size,
      item.createdAt,
      item.expiresAt
    );
    return this.getItem(item.id);
  }

  getItem(id) {
    return this.getItemStatement.get(id);
  }

  listItems(now, limit = 100) {
    return this.listItemsStatement.all(now, limit);
  }

  deleteItem(id) {
    return this.deleteItemStatement.get(id);
  }

  usedFileBytes(now) {
    return Number(this.usedFileBytesStatement.get(now).bytes);
  }

  cleanup(now) {
    const expired = this.expiredItemsStatement.all(now);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.deleteExpiredItemsStatement.run(now);
      this.db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    return expired;
  }

  close() {
    this.db.exec("PRAGMA optimize");
    this.db.close();
  }
}
