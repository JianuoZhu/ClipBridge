import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import {
  createPasswordVerifier,
  createSession,
  hashToken,
  LoginLimiter,
  parseCookies,
} from "./auth.js";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web");
const staticFiles = new Map([
  ["/", ["index.html", "text/html; charset=utf-8"]],
  ["/index.html", ["index.html", "text/html; charset=utf-8"]],
  ["/styles.css", ["styles.css", "text/css; charset=utf-8"]],
  ["/app.js", ["app.js", "text/javascript; charset=utf-8"]],
  ["/manifest.webmanifest", ["manifest.webmanifest", "application/manifest+json; charset=utf-8"]],
  ["/sw.js", ["sw.js", "text/javascript; charset=utf-8"]],
]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

function json(response, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "Cache-Control": "no-store",
  });
  response.end(body);
}

function noContent(response) {
  response.writeHead(204, { "Cache-Control": "no-store" });
  response.end();
}

async function readJson(request, maxBytes = 64 * 1024) {
  if (Number(request.headers["content-length"]) > maxBytes) {
    throw new HttpError(413, "请求内容过大");
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, "请求必须是有效的 JSON 对象");
  }
}

function firstHeader(value) {
  return Array.isArray(value) ? value[0] : value;
}

function sanitizeFileName(encoded) {
  let value;
  try {
    value = decodeURIComponent(encoded || "");
  } catch {
    throw new HttpError(400, "文件名编码无效");
  }
  value = value.normalize("NFC").replace(/^.*[\\/]/, "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!value) value = "file";
  value = Array.from(value).slice(0, 240).join("");
  return value;
}

function normalizeMimeType(value) {
  const mime = (value || "application/octet-stream").split(";", 1)[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime)
    ? mime
    : "application/octet-stream";
}

function publicItem(row) {
  const common = {
    id: row.id,
    kind: row.kind,
    size: row.size,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
  if (row.kind === "text") return { ...common, text: row.text_content };
  return { ...common, fileName: row.file_name, mimeType: row.mime_type };
}

function encodeRFC5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function contentDisposition(fileName) {
  const fallback = fileName
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .slice(0, 120) || "download";
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeRFC5987(fileName)}`;
}

function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match) return false;
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= size) {
    return false;
  }
  return { start, end: Math.min(end, size - 1) };
}

function validBlobName(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}

export async function createClipServer({ config, store }) {
  const verifyPassword = await createPasswordVerifier(config.password, { store, username: config.username });
  const loginLimiter = new LoginLimiter({ attempts: 30, windowMs: 5 * 60 * 1000 });
  const cookieName = config.cookieSecure ? "__Host-clip_session" : "clip_session";
  const eventClients = new Map();
  const activeUploads = new Set();
  const findBlob = store.db.prepare("SELECT 1 FROM items WHERE blob_name = ?");
  let loginInFlight = 0;
  let uploadingBytes = 0;
  let cleanupTask;

  const expireClient = (client) => {
    eventClients.delete(client);
    client.end("event: session-expired\ndata: {}\n\n");
  };

  const broadcast = (payload) => {
    for (const [client, tokenHash] of eventClients) {
      if (!store.findSession(tokenHash, Date.now())) {
        expireClient(client);
      } else if (!client.write(payload)) {
        // Reconnecting clients refresh their list; do not buffer unbounded events.
        eventClients.delete(client);
        client.destroy();
      }
    }
  };

  const notify = (action, itemId) => {
    broadcast(`event: items\ndata: ${JSON.stringify({ action, itemId })}\n\n`);
  };

  const removeBlob = async (blobName) => {
    if (!validBlobName(blobName)) return;
    try {
      await fs.promises.unlink(path.join(store.blobsDir, blobName));
    } catch (error) {
      if (error?.code !== "ENOENT") console.error("Unable to remove expired blob");
    }
  };

  const cleanupExpired = () => {
    if (cleanupTask) return cleanupTask;
    cleanupTask = (async () => {
      const expired = store.cleanup(Date.now());
      if (expired.length) notify("expired");
      // Recover files left by interrupted uploads or failed earlier deletions.
      const blobs = await fs.promises.readdir(store.blobsDir, { withFileTypes: true });
      for (const entry of blobs) {
        if (entry.isFile() && validBlobName(entry.name) && !activeUploads.has(entry.name) && !findBlob.get(entry.name)) {
          await removeBlob(entry.name);
        }
      }
      const partials = await fs.promises.readdir(store.uploadsDir, { withFileTypes: true });
      for (const entry of partials) {
        const blobName = entry.name.slice(0, -5);
        if (entry.isFile() && entry.name.endsWith(".part") && validBlobName(blobName) && !activeUploads.has(blobName)) {
          await fs.promises.unlink(path.join(store.uploadsDir, entry.name)).catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
      }
    })().catch(() => {
      console.error("Expired-item cleanup failed");
    }).finally(() => { cleanupTask = undefined; });
    return cleanupTask;
  };

  await cleanupExpired();
  const cleanupTimer = setInterval(cleanupExpired, 15 * 60 * 1000);
  cleanupTimer.unref();
  const heartbeatTimer = setInterval(() => {
    broadcast(": heartbeat\n\n");
  }, 20_000);
  heartbeatTimer.unref();

  const getSession = (request) => {
    const token = parseCookies(request.headers.cookie).get(cookieName);
    if (!token || token.length > 128) return null;
    const session = store.findSession(hashToken(token), Date.now());
    return session ? { ...session, token } : null;
  };

  const requireSession = (request) => {
    const session = getSession(request);
    if (!session) throw new HttpError(401, "请先登录");
    return session;
  };

  const requireMutationRequest = (request) => {
    if (request.headers["x-clip-request"] !== "1") {
      throw new HttpError(403, "请求校验失败");
    }
    const origin = firstHeader(request.headers.origin);
    if (origin) {
      try {
        const protocol = config.cookieSecure ? "https:" : "http:";
        const expected = new URL(`${protocol}//${request.headers.host}`).origin;
        if (new URL(origin).origin !== expected || origin !== expected) throw new Error();
      } catch {
        throw new HttpError(403, "来源校验失败");
      }
    }
  };

  const saveUpload = async (request, blobName) => {
    const statedLength = Number(firstHeader(request.headers["content-length"]));
    if (Number.isFinite(statedLength) && statedLength > config.maxFileBytes) {
      throw new HttpError(413, "文件超过大小限制");
    }
    if (Number.isFinite(statedLength) && store.usedFileBytes(Date.now()) + uploadingBytes + statedLength > config.maxStorageBytes) {
      throw new HttpError(507, "存储空间配额不足");
    }

    const temporaryPath = path.join(store.uploadsDir, `${blobName}.part`);
    const finalPath = path.join(store.blobsDir, blobName);
    activeUploads.add(blobName);
    let handle;
    let total = 0;
    let completed = false;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      uploadingBytes -= total;
      activeUploads.delete(blobName);
    };
    try {
      handle = await fs.promises.open(temporaryPath, "wx", 0o600);
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        if (total + chunk.length > config.maxFileBytes) {
          throw new HttpError(413, "文件超过大小限制");
        }
        if (store.usedFileBytes(Date.now()) + uploadingBytes + chunk.length > config.maxStorageBytes) {
          throw new HttpError(507, "存储空间配额不足");
        }
        total += chunk.length;
        uploadingBytes += chunk.length;
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
          if (bytesWritten === 0) throw new Error("Upload write made no progress");
          offset += bytesWritten;
        }
      }
      if (total === 0) throw new HttpError(400, "不能上传空文件");
      await handle.sync();
      await handle.close();
      await fs.promises.rename(temporaryPath, finalPath);
      completed = true;
      return { size: total, release };
    } finally {
      try {
        await handle?.close();
      } catch {}
      if (!completed) {
        try {
          await fs.promises.unlink(temporaryPath);
        } catch (error) {
          if (error.code !== "ENOENT") console.error("Unable to remove partial upload");
        }
        release();
      }
    }
  };

  const handler = async (request, response) => {
    securityHeaders(response);
    const requestUrl = new URL(request.url || "/", "http://local");
    const pathname = requestUrl.pathname;

    if (config.domain && pathname !== "/healthz") {
      const host = (request.headers.host || "").split(":", 1)[0].toLowerCase();
      if (host !== config.domain) throw new HttpError(421, "主机名不匹配");
    }

    if (request.method === "GET" && pathname === "/healthz") {
      store.db.prepare("SELECT 1").get();
      return json(response, 200, { status: "ok" });
    }

    if (request.method === "GET" && pathname === "/api/session") {
      const session = getSession(request);
      if (!session) return json(response, 200, { authenticated: false });
      return json(response, 200, {
        authenticated: true,
        username: session.username,
        settings: {
          retentionHours: config.retentionHours,
          maxFileBytes: config.maxFileBytes,
          maxStorageBytes: config.maxStorageBytes,
          maxTextBytes: config.maxTextBytes,
        },
      });
    }

    if (request.method === "POST" && pathname === "/api/auth/login") {
      requireMutationRequest(request);
      const key = request.socket.remoteAddress || "unknown";
      if (!loginLimiter.allowed(key)) throw new HttpError(429, "尝试次数过多，请稍后再试");
      const body = await readJson(request, 16 * 1024);
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (loginInFlight >= 4) throw new HttpError(429, "登录请求过多，请稍后再试");
      if (!loginLimiter.allowed(key)) throw new HttpError(429, "尝试次数过多，请稍后再试");
      loginLimiter.fail(key);
      loginInFlight += 1;
      let passwordMatches = false;
      try {
        passwordMatches = password.length <= 1024 ? await verifyPassword(password) : false;
      } finally {
        loginInFlight -= 1;
      }
      const valid = username === config.username && passwordMatches;
      if (!valid) {
        throw new HttpError(401, "用户名或密码错误");
      }
      loginLimiter.success(key);
      const session = createSession(store, config.username, config.sessionDays);
      const cookie = [
        `${cookieName}=${session.token}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${config.sessionDays * 86400}`,
      ];
      if (config.cookieSecure) cookie.push("Secure");
      response.setHeader("Set-Cookie", cookie.join("; "));
      return json(response, 200, {
        authenticated: true,
        username: config.username,
        settings: {
          retentionHours: config.retentionHours,
          maxFileBytes: config.maxFileBytes,
          maxStorageBytes: config.maxStorageBytes,
          maxTextBytes: config.maxTextBytes,
        },
      });
    }

    if (request.method === "POST" && pathname === "/api/auth/logout") {
      requireMutationRequest(request);
      const session = requireSession(request);
      const tokenHash = hashToken(session.token);
      store.deleteSession(tokenHash);
      for (const [client, clientTokenHash] of eventClients) {
        if (clientTokenHash === tokenHash) expireClient(client);
      }
      const cookie = [`${cookieName}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"];
      if (config.cookieSecure) cookie.push("Secure");
      response.setHeader("Set-Cookie", cookie.join("; "));
      return noContent(response);
    }

    if (request.method === "GET" && pathname === "/api/items") {
      requireSession(request);
      const items = store.listItems(Date.now()).map(publicItem);
      return json(response, 200, { items });
    }

    if (request.method === "POST" && pathname === "/api/items/text") {
      requireMutationRequest(request);
      requireSession(request);
      // JSON can encode a single text byte as a six-byte Unicode escape.
      const body = await readJson(request, config.maxTextBytes * 6 + 1024);
      requireSession(request);
      if (typeof body.text !== "string" || body.text.length === 0) {
        throw new HttpError(400, "文字内容不能为空");
      }
      const size = Buffer.byteLength(body.text);
      if (size > config.maxTextBytes) throw new HttpError(413, "文字内容过大");
      const now = Date.now();
      const item = store.createItem({
        id: randomUUID(),
        kind: "text",
        textContent: body.text,
        size,
        createdAt: now,
        expiresAt: now + config.retentionHours * 60 * 60 * 1000,
      });
      notify("created", item.id);
      return json(response, 201, { item: publicItem(item) });
    }

    if (request.method === "POST" && pathname === "/api/items/file") {
      requireMutationRequest(request);
      requireSession(request);
      const fileName = sanitizeFileName(firstHeader(request.headers["x-clip-file-name"]));
      const mimeType = normalizeMimeType(firstHeader(request.headers["content-type"]));
      const blobName = randomUUID();
      const upload = await saveUpload(request, blobName);
      const { size } = upload;
      const now = Date.now();
      try {
        requireSession(request);
        const item = store.createItem({
          id: randomUUID(),
          kind: "file",
          fileName,
          mimeType,
          blobName,
          size,
          createdAt: now,
          expiresAt: now + config.retentionHours * 60 * 60 * 1000,
        });
        notify("created", item.id);
        return json(response, 201, { item: publicItem(item) });
      } catch (error) {
        await removeBlob(blobName);
        throw error;
      } finally {
        upload.release();
      }
    }

    const fileMatch = /^\/api\/items\/([0-9a-f-]{36})\/file$/.exec(pathname);
    if ((request.method === "GET" || request.method === "HEAD") && fileMatch) {
      requireSession(request);
      const item = store.getItem(fileMatch[1]);
      if (!item || item.expires_at <= Date.now() || item.kind !== "file" || !validBlobName(item.blob_name)) {
        throw new HttpError(404, "文件不存在或已经过期");
      }
      const filePath = path.join(store.blobsDir, item.blob_name);
      let handle;
      try {
        handle = await fs.promises.open(filePath, "r");
      } catch (error) {
        if (error.code === "ENOENT") throw new HttpError(404, "文件不存在");
        throw error;
      }
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) throw new HttpError(404, "文件不存在");
        const range = request.method === "HEAD" ? null : parseRange(firstHeader(request.headers.range), stat.size);
        if (range === false) {
          response.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store" });
          return response.end();
        }
        const headers = {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": contentDisposition(item.file_name),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Content-Length": range ? range.end - range.start + 1 : stat.size,
        };
        if (range) headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
        response.writeHead(range ? 206 : 200, headers);
        if (request.method === "HEAD") return response.end();
        await pipeline(handle.createReadStream(range || {}), response);
        return;
      } finally {
        await handle.close().catch(() => {});
      }
    }

    const deleteMatch = /^\/api\/items\/([0-9a-f-]{36})$/.exec(pathname);
    if (request.method === "DELETE" && deleteMatch) {
      requireMutationRequest(request);
      requireSession(request);
      const item = store.deleteItem(deleteMatch[1]);
      if (!item) throw new HttpError(404, "内容不存在");
      await removeBlob(item.blob_name);
      notify("deleted", item.id);
      return noContent(response);
    }

    if (request.method === "GET" && pathname === "/api/events") {
      const session = requireSession(request);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("event: ready\ndata: {}\n\n");
      eventClients.set(response, hashToken(session.token));
      response.on("close", () => eventClients.delete(response));
      return;
    }

    if ((request.method === "GET" || request.method === "HEAD") && staticFiles.has(pathname)) {
      const [name, contentType] = staticFiles.get(pathname);
      const body = await fs.promises.readFile(path.join(webDir, name));
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": body.length,
        "Cache-Control": name === "index.html" ? "no-store" : "no-cache",
      });
      return response.end(request.method === "HEAD" ? undefined : body);
    }

    throw new HttpError(404, "未找到");
  };

  const server = http.createServer((request, response) => {
    handler(request, response).catch((error) => {
      if (response.destroyed) return;
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Request failed");
      if (!request.readableEnded) {
        response.setHeader("Connection", "close");
        request.resume();
      }
      json(response, status, { error: error instanceof HttpError ? error.message : "服务器内部错误" });
    });
  });
  server.headersTimeout = 15_000;
  server.requestTimeout = 60 * 60 * 1000;
  server.keepAliveTimeout = 65_000;
  server.maxHeadersCount = 50;
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });

  return {
    server,
    close(callback) {
      clearInterval(cleanupTimer);
      clearInterval(heartbeatTimer);
      for (const client of eventClients.keys()) client.end();
      eventClients.clear();
      server.close(() => {
        Promise.resolve(cleanupTask).then(() => callback?.());
      });
    },
  };
}
