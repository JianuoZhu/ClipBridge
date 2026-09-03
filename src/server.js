import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
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
  const chunks = [];
  let total = 0;
  for await (const chunk of request) {
    total += chunk.length;
    if (total > maxBytes) throw new HttpError(413, "请求内容过大");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "JSON 格式无效");
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
  value = value.normalize("NFC").replace(/^.*[\\/]/, "").replaceAll("\0", "").trim();
  if (!value) value = "file";
  if (value.length > 240) value = value.slice(0, 240);
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
    if (!Number.isInteger(suffix) || suffix <= 0) return false;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Number(match[2]);
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) {
    return false;
  }
  return { start, end: Math.min(end, size - 1) };
}

function validBlobName(value) {
  return typeof value === "string" && /^[0-9a-f-]{36}$/.test(value);
}

export async function createClipServer({ config, store }) {
  const verifyPassword = await createPasswordVerifier(config.password);
  const loginLimiter = new LoginLimiter({ attempts: 30, windowMs: 5 * 60 * 1000 });
  const cookieName = config.cookieSecure ? "__Host-clip_session" : "clip_session";
  const eventClients = new Set();
  let loginInFlight = 0;

  const removeBlob = async (blobName) => {
    if (!validBlobName(blobName)) return;
    try {
      await fs.promises.unlink(path.join(store.blobsDir, blobName));
    } catch (error) {
      if (error?.code !== "ENOENT") console.error("Unable to remove expired blob");
    }
  };

  const cleanupExpired = async () => {
    try {
      const expired = store.cleanup(Date.now());
      await Promise.all(expired.map((item) => removeBlob(item.blob_name)));
      const partials = await fs.promises.readdir(store.uploadsDir, { withFileTypes: true });
      await Promise.all(partials.filter((entry) => entry.isFile() && entry.name.endsWith(".part")).map(async (entry) => {
        const partialPath = path.join(store.uploadsDir, entry.name);
        const stat = await fs.promises.stat(partialPath);
        if (stat.mtimeMs < Date.now() - 60 * 60 * 1000) await fs.promises.unlink(partialPath);
      }));
    } catch {
      console.error("Expired-item cleanup failed");
    }
  };

  await cleanupExpired();
  const cleanupTimer = setInterval(cleanupExpired, 15 * 60 * 1000);
  cleanupTimer.unref();
  const heartbeatTimer = setInterval(() => {
    for (const client of eventClients) client.write(": heartbeat\n\n");
  }, 20_000);
  heartbeatTimer.unref();

  const notify = (action, itemId) => {
    const payload = `event: items\ndata: ${JSON.stringify({ action, itemId })}\n\n`;
    for (const client of eventClients) client.write(payload);
  };

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
        if (new URL(origin).host !== request.headers.host) throw new Error();
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

    const temporaryPath = path.join(store.uploadsDir, `${blobName}.part`);
    const finalPath = path.join(store.blobsDir, blobName);
    const handle = await fs.promises.open(temporaryPath, "wx", 0o600);
    let total = 0;
    let completed = false;
    try {
      for await (const chunk of request) {
        total += chunk.length;
        if (total > config.maxFileBytes) {
          request.resume();
          throw new HttpError(413, "文件超过大小限制");
        }
        await handle.write(chunk);
      }
      if (total === 0) throw new HttpError(400, "不能上传空文件");
      await handle.sync();
      await handle.close();
      await fs.promises.rename(temporaryPath, finalPath);
      completed = true;
      return total;
    } finally {
      try {
        await handle.close();
      } catch {}
      if (!completed) {
        try {
          await fs.promises.unlink(temporaryPath);
        } catch {}
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
      loginInFlight += 1;
      let passwordMatches = false;
      try {
        passwordMatches = password.length <= 1024 ? await verifyPassword(password) : false;
      } finally {
        loginInFlight -= 1;
      }
      const valid = username === config.username && passwordMatches;
      if (!valid) {
        loginLimiter.fail(key);
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
        },
      });
    }

    if (request.method === "POST" && pathname === "/api/auth/logout") {
      requireMutationRequest(request);
      const session = requireSession(request);
      store.deleteSession(hashToken(session.token));
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
      const body = await readJson(request, config.maxTextBytes + 1024);
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
      const size = await saveUpload(request, blobName);
      const now = Date.now();
      if (store.usedFileBytes(now) + size > config.maxStorageBytes) {
        await removeBlob(blobName);
        throw new HttpError(507, "存储空间配额不足");
      }
      try {
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
      }
    }

    const fileMatch = /^\/api\/items\/([0-9a-f-]{36})\/file$/.exec(pathname);
    if (request.method === "GET" && fileMatch) {
      requireSession(request);
      const item = store.getItem(fileMatch[1]);
      if (!item || item.expires_at <= Date.now() || item.kind !== "file" || !validBlobName(item.blob_name)) {
        throw new HttpError(404, "文件不存在或已经过期");
      }
      const filePath = path.join(store.blobsDir, item.blob_name);
      let stat;
      try {
        stat = await fs.promises.stat(filePath);
      } catch {
        throw new HttpError(404, "文件不存在");
      }
      const range = parseRange(firstHeader(request.headers.range), stat.size);
      if (range === false) {
        response.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return response.end();
      }
      const headers = {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": contentDisposition(item.file_name),
        "Accept-Ranges": "bytes",
        "Cache-Control": "private, no-store",
      };
      if (range) {
        headers["Content-Range"] = `bytes ${range.start}-${range.end}/${stat.size}`;
        headers["Content-Length"] = range.end - range.start + 1;
        response.writeHead(206, headers);
        return fs.createReadStream(filePath, range).pipe(response);
      }
      headers["Content-Length"] = stat.size;
      response.writeHead(200, headers);
      return fs.createReadStream(filePath).pipe(response);
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
      requireSession(request);
      response.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      response.write("event: ready\ndata: {}\n\n");
      eventClients.add(response);
      request.on("close", () => eventClients.delete(response));
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
      if (response.headersSent) {
        response.destroy();
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      if (status === 500) console.error("Request failed");
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
      for (const client of eventClients) client.end();
      eventClients.clear();
      server.close(callback);
    },
  };
}
