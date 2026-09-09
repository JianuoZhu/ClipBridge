import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { createP2pSignaling, P2pError } from "./p2p.js";
import {
  createPasswordVerifier,
  createSession,
  hashToken,
  LoginLimiter,
  parseCookies,
} from "./auth.js";

const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist/web");
const staticContentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".bcmap", "application/octet-stream"],
  [".pfb", "application/octet-stream"],
  [".ttf", "font/ttf"],
  [".otf", "font/otf"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".avif", "image/avif"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"],
]);
const maxImagePreviewBytes = 20 * 1024 * 1024;
const maxPdfPreviewBytes = 100 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function securityHeaders(response, nonce) {
  response.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; script-src-attr 'none'; style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; worker-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=()");
}

function isInsideDirectory(directory, candidate) {
  const relative = path.relative(directory, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function findStaticFile(pathname) {
  // Never turn a missing API route into an HTML response, or expose dotfiles,
  // Windows alternate data streams, source maps, or files outside the build.
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded === "/api" || decoded.startsWith("/api/") || /[\\:\u0000-\u001f\u007f]/.test(decoded)) return null;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part.startsWith("."))) return null;
  const fileName = decoded === "/" ? "index.html" : parts.join("/");
  const contentType = staticContentTypes.get(path.extname(fileName).toLowerCase());
  if (!contentType) return null;
  const candidate = path.resolve(webDir, fileName);
  if (!isInsideDirectory(webDir, candidate)) return null;
  try {
    const [root, realFile] = await Promise.all([fs.promises.realpath(webDir), fs.promises.realpath(candidate)]);
    if (!isInsideDirectory(root, realFile)) return null;
    const stat = await fs.promises.stat(realFile);
    return stat.isFile() ? { filePath: realFile, fileName, contentType } : null;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error.code)) return null;
    throw error;
  }
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
  return { ...common, fileName: row.file_name, mimeType: row.mime_type, previewType: previewType(row) };
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

function previewType(item, maxTextBytes = 0) {
  const extension = path.extname(item.file_name || "").toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(extension) && item.size <= maxImagePreviewBytes) return "image";
  if (extension === ".pdf" && item.size <= maxPdfPreviewBytes) return "pdf";
  if (item.size <= maxTextBytes && [".txt", ".md", ".markdown", ".json", ".csv", ".tsv", ".log", ".yaml", ".yml", ".xml", ".html", ".css", ".js", ".ts", ".py", ".sh", ".ini", ".toml", ".sql", ".svg"].includes(extension)) return "text";
  return null;
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return "image/png";
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "image/gif";
  if (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  throw new HttpError(415, "此文件无法作为图片预览，请下载查看");
}

function previewMime(bytes, type) {
  if (type === "image") return imageMime(bytes);
  if (type === "pdf" && /^%PDF-(?:1\.[0-7]|2\.0)(?:\s|$)/.test(bytes.toString("ascii"))) return "application/pdf";
  throw new HttpError(415, "此文件无法作为 PDF 预览，请下载查看");
}

export async function createClipServer({ config, store }) {
  const p2p = createP2pSignaling(config.p2p);
  const pin = config.pin ?? "1223";
  // Bind every session to both credentials and the new role model; upgrading revokes legacy sessions.
  await createPasswordVerifier(hashToken(JSON.stringify(["roles-v1", pin, config.username, config.password])), { store, username: config.username });
  const verifyPassword = await createPasswordVerifier(config.password || "");
  const verifyPin = await createPasswordVerifier(pin);
  const loginLimiter = new LoginLimiter();
  const cookieName = config.cookieSecure ? "__Host-clip_session" : "clip_session";
  const eventClients = new Map();
  const activeUploads = new Set();
  const findBlob = store.db.prepare("SELECT 1 FROM items WHERE blob_name = ? UNION ALL SELECT 1 FROM library_files WHERE blob_name = ?");
  let loginInFlight = 0;
  let uploadingBytes = 0;
  let cleanupTask;

  const expireClient = (client) => {
    eventClients.delete(client);
    client.end("event: session-expired\ndata: {}\n\n");
  };

  const broadcast = (payload, adminOnly = false) => {
    for (const [client, tokenHash] of eventClients) {
      const session = store.findSession(tokenHash, Date.now());
      if (!session) {
        expireClient(client);
      } else if ((!adminOnly || session.role === "admin") && !client.write(payload)) {
        // Reconnecting clients refresh their list; do not buffer unbounded events.
        eventClients.delete(client);
        client.destroy();
      }
    }
  };

  const notify = (action, itemId) => {
    broadcast(`event: items\ndata: ${JSON.stringify({ action, itemId })}\n\n`);
  };
  const notifyLibrary = () => broadcast("event: library\ndata: {}\n\n", true);
  const publicFile = (row) => ({
    id: row.id, fileName: row.file_name, mimeType: row.mime_type, size: row.size,
    createdAt: row.created_at, updatedAt: row.updated_at, revision: row.revision,
    previewType: previewType(row, config.maxTextBytes),
  });

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
        if (entry.isFile() && validBlobName(entry.name) && !activeUploads.has(entry.name) && !findBlob.get(entry.name, entry.name)) {
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

  const requireAdmin = (request) => {
    const session = requireSession(request);
    if (session.role !== "admin") throw new HttpError(403, "文件库仅限管理员使用");
    return session;
  };

  const sessionPayload = (session) => ({
    authenticated: true, username: session.username, role: session.role,
    adminEnabled: Boolean(config.password),
    settings: {
      retentionHours: config.retentionHours, maxFileBytes: config.maxFileBytes,
      maxStorageBytes: config.maxStorageBytes, maxTextBytes: config.maxTextBytes,
    },
  });

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
      if (!session) return json(response, 200, { authenticated: false, adminEnabled: Boolean(config.password) });
      return json(response, 200, sessionPayload(session));
    }

    if (request.method === "GET" && pathname === "/api/p2p/config") {
      requireSession(request);
      return json(response, 200, p2p.configuration());
    }

    if (request.method === "POST" && pathname === "/api/p2p/offer") {
      requireMutationRequest(request);
      const session = requireSession(request);
      const body = await readJson(request, 128 * 1024);
      requireSession(request);
      const controller = new AbortController();
      const cancel = () => { if (!response.writableEnded) controller.abort(); };
      response.on("close", cancel);
      try {
        const answer = await p2p.offer({ body, session, cookieName,
          host: config.domain || firstHeader(request.headers.host), signal: controller.signal });
        requireSession(request);
        return json(response, 200, answer);
      } finally { response.off("close", cancel); }
    }

    if (request.method === "POST" && ["/api/auth/login", "/api/auth/admin"].includes(pathname)) {
      requireMutationRequest(request);
      const adminLogin = pathname === "/api/auth/admin";
      const key = `${adminLogin ? "admin" : "pin"}:${request.socket.remoteAddress || "unknown"}`;
      if (!loginLimiter.allowed(key)) throw new HttpError(429, "尝试次数过多，请稍后再试");
      const body = await readJson(request, 16 * 1024);
      const username = typeof body.username === "string" ? body.username : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (loginInFlight >= 4) throw new HttpError(429, "登录请求过多，请稍后再试");
      if (!loginLimiter.allowed(key)) throw new HttpError(429, "尝试次数过多，请稍后再试");
      loginLimiter.fail(key);
      loginInFlight += 1;
      let valid = false;
      try {
        valid = adminLogin
          ? Boolean(config.password) && await verifyPassword(password) && username === config.username
          : typeof body.pin === "string" && /^\d{4,12}$/.test(body.pin) && await verifyPin(body.pin);
      } finally {
        loginInFlight -= 1;
      }
      if (!valid) {
        throw new HttpError(401, adminLogin ? "管理员账号或密码错误" : "PIN 码错误");
      }
      loginLimiter.success(key);
      const previous = getSession(request);
      if (previous) {
        const previousHash = hashToken(previous.token);
        store.deleteSession(previousHash);
        for (const [client, tokenHash] of eventClients) {
          if (tokenHash === previousHash) expireClient(client);
        }
      }
      const role = adminLogin ? "admin" : "member";
      const sessionUsername = adminLogin ? config.username : "PIN";
      const session = createSession(store, sessionUsername, config.sessionDays, role);
      const cookie = [
        `${cookieName}=${session.token}`,
        "Path=/",
        "HttpOnly",
        "SameSite=Strict",
        `Max-Age=${config.sessionDays * 86400}`,
      ];
      if (config.cookieSecure) cookie.push("Secure");
      response.setHeader("Set-Cookie", cookie.join("; "));
      return json(response, 200, sessionPayload({ username: sessionUsername, role }));
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
      const now = Date.now();
      const items = store.listItems(now).map(publicItem);
      return json(response, 200, { items, latest: store.latestItems(now).map(publicItem) });
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

    if (pathname === "/api/library" || pathname.startsWith("/api/library/")) {
      requireAdmin(request);
      if (!["GET", "HEAD"].includes(request.method)) requireMutationRequest(request);
    }

    if (request.method === "GET" && pathname === "/api/library") {
      return json(response, 200, { files: store.listLibraryFiles().map(publicFile), usedBytes: store.usedFileBytes(Date.now()) });
    }

    if (request.method === "POST" && pathname === "/api/library") {
      const fileName = sanitizeFileName(firstHeader(request.headers["x-clip-file-name"]));
      const mimeType = normalizeMimeType(firstHeader(request.headers["content-type"]));
      const blobName = randomUUID();
      const upload = await saveUpload(request, blobName);
      try {
        requireAdmin(request);
        const file = store.createLibraryFile({ id: randomUUID(), fileName, mimeType, blobName, size: upload.size, createdAt: Date.now() });
        notifyLibrary();
        return json(response, 201, { file: publicFile(file) });
      } catch (error) {
        await removeBlob(blobName);
        throw error;
      } finally {
        upload.release();
      }
    }

    const libraryMatch = /^\/api\/library\/([0-9a-f-]{36})(?:\/(content|file|preview))?$/.exec(pathname);
    if (libraryMatch && ["GET", "PATCH", "DELETE"].includes(request.method) && !["file", "preview"].includes(libraryMatch[2])) {
      const file = store.getLibraryFile(libraryMatch[1]);
      if (!file || !validBlobName(file.blob_name)) throw new HttpError(404, "文件不存在");
      if (request.method === "GET" && libraryMatch[2] === "content") {
        if (previewType(file, config.maxTextBytes) !== "text") throw new HttpError(415, "此文件暂不支持文本预览和编辑，请下载查看");
        let bytes;
        try {
          bytes = await fs.promises.readFile(path.join(store.blobsDir, file.blob_name));
        } catch (error) {
          if (error.code === "ENOENT") throw new HttpError(404, "文件不存在");
          throw error;
        }
        requireAdmin(request);
        let text;
        try {
          text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
          if (text.includes("\u0000")) throw new Error();
        } catch {
          throw new HttpError(415, "仅支持 UTF-8 文本预览和编辑，请下载查看此文件");
        }
        return json(response, 200, { file: publicFile(file), text });
      }
      if (libraryMatch[2]) throw new HttpError(405, "不支持此操作");
      if (request.method === "GET") return json(response, 200, { file: publicFile(file) });
      const body = await readJson(request, config.maxTextBytes * 6 + 2048);
      requireAdmin(request);
      if (!Number.isSafeInteger(body.revision) || body.revision !== file.revision) throw new HttpError(409, "文件已被修改，请重新打开后再操作");
      if (request.method === "DELETE") {
        const deleted = store.deleteLibraryFile(file.id, body.revision);
        if (!deleted) throw new HttpError(409, "文件已被修改，请刷新后重试");
        await removeBlob(deleted.blob_name);
        notifyLibrary();
        return noContent(response);
      }
      if (typeof body.fileName !== "string" || !body.fileName.trim() || Array.from(body.fileName).length > 240) throw new HttpError(400, "请输入有效文件名（最多 240 个字符）");
      const fileName = sanitizeFileName(encodeURIComponent(body.fileName));
      if (fileName !== body.fileName.normalize("NFC").trim()) throw new HttpError(400, "文件名不能包含路径或控制字符");
      const editingText = Object.hasOwn(body, "text");
      if (editingText && (typeof body.text !== "string" || body.text.includes("\u0000") || previewType(file, config.maxTextBytes) !== "text")) throw new HttpError(415, "此内容不支持文本编辑");
      const bytes = editingText ? Buffer.from(body.text, "utf8") : null;
      if (bytes && (bytes.length > config.maxTextBytes || bytes.length > config.maxFileBytes)) throw new HttpError(413, "文字内容过大");
      const reservation = bytes ? Math.max(0, bytes.length - file.size) : 0;
      if (reservation && store.usedFileBytes(Date.now()) + uploadingBytes + reservation > config.maxStorageBytes) throw new HttpError(507, "存储空间配额不足");
      const blobName = bytes ? randomUUID() : file.blob_name;
      const temporaryPath = path.join(store.uploadsDir, `${blobName}.part`);
      let committed = false;
      uploadingBytes += reservation;
      if (bytes) activeUploads.add(blobName);
      try {
        if (bytes) {
          await fs.promises.writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600, flush: true });
          await fs.promises.rename(temporaryPath, path.join(store.blobsDir, blobName));
        }
        requireAdmin(request);
        const updated = store.updateLibraryFile(file.id, body.revision, { fileName, blobName, size: bytes ? bytes.length : file.size });
        if (!updated) throw new HttpError(409, "文件已被修改，请重新打开后再保存");
        committed = true;
        if (bytes) await removeBlob(file.blob_name);
        notifyLibrary();
        return json(response, 200, { file: publicFile(updated) });
      } finally {
        uploadingBytes -= reservation;
        if (bytes) {
          if (!committed) await removeBlob(blobName);
          await fs.promises.unlink(temporaryPath).catch(() => {});
          activeUploads.delete(blobName);
        }
      }
    }

    const sharedFileMatch = /^\/api\/items\/([0-9a-f-]{36})\/(file|preview)$/.exec(pathname);
    const libraryDownload = libraryMatch && ["file", "preview"].includes(libraryMatch[2]);
    const fileMatch = sharedFileMatch || (libraryDownload && libraryMatch);
    if ((request.method === "GET" || request.method === "HEAD") && fileMatch) {
      requireSession(request);
      if (libraryDownload) requireAdmin(request);
      const item = libraryDownload ? store.getLibraryFile(fileMatch[1]) : store.getItem(fileMatch[1]);
      const preview = libraryDownload ? libraryMatch[2] === "preview" : sharedFileMatch[2] === "preview";
      if (!item || (!libraryDownload && (item.expires_at <= Date.now() || item.kind !== "file")) || !validBlobName(item.blob_name)) {
        throw new HttpError(404, "文件不存在或已经过期");
      }
      const type = previewType(item, config.maxTextBytes);
      if (preview && !["image", "pdf"].includes(type)) throw new HttpError(415, "此文件暂不支持在线预览");
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
        let contentType = "application/octet-stream";
        if (preview) {
          const signature = Buffer.alloc(12);
          await handle.read(signature, 0, 12, 0);
          contentType = previewMime(signature, type);
        }
        const range = request.method === "HEAD" ? null : parseRange(firstHeader(request.headers.range), stat.size);
        if (range === false) {
          response.writeHead(416, { "Content-Range": `bytes */${stat.size}`, "Cache-Control": "no-store" });
          return response.end();
        }
        const headers = {
          "Content-Type": contentType,
          "Content-Disposition": preview ? "inline" : contentDisposition(item.file_name),
          "Accept-Ranges": "bytes",
          "Cache-Control": "private, no-store",
          "Content-Encoding": "identity",
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

    if (request.method === "GET" || request.method === "HEAD") {
      const file = await findStaticFile(pathname);
      if (!file) throw new HttpError(404, "未找到");
      let body = await fs.promises.readFile(file.filePath);
      if (file.fileName === "index.html") {
        const nonce = randomBytes(18).toString("base64url");
        body = Buffer.from(body.toString("utf8").replaceAll("__CSP_NONCE__", nonce));
        securityHeaders(response, nonce);
      }
      response.writeHead(200, {
        "Content-Type": file.contentType,
        "Content-Length": body.length,
        "Cache-Control": file.fileName === "index.html" ? "no-store" : file.fileName.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache",
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
      const known = error instanceof HttpError || error instanceof P2pError;
      const status = known ? error.status : 500;
      if (status === 500) console.error("Request failed");
      if (!request.readableEnded) {
        response.setHeader("Connection", "close");
        request.resume();
      }
      json(response, status, { error: known ? error.message : "服务器内部错误" });
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
      p2p.close();
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
