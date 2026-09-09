import { randomBytes } from "node:crypto";
import { promisify } from "node:util";

const randomPayload = promisify(randomBytes);
export const maxSpeedBytes = 2 * 1024 * 1024;

export class ConnectionSpeedError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requestedBytes(request, url) {
  const values = url.searchParams.getAll("bytes");
  if (values.length !== 1 || !/^[1-9][0-9]{0,6}$/.test(values[0])) {
    throw new ConnectionSpeedError(400, "测速数据大小无效");
  }
  const bytes = Number(values[0]);
  if (bytes > maxSpeedBytes) throw new ConnectionSpeedError(413, "单次测速数据不能超过 2 MiB");
  const encoding = request.headers["content-encoding"];
  if (encoding !== undefined && String(encoding).trim().toLowerCase() !== "identity") {
    throw new ConnectionSpeedError(415, "测速不接受压缩数据");
  }
  const length = request.headers["content-length"];
  if (request.method === "GET") {
    if ((length !== undefined && length !== "0") || request.headers["transfer-encoding"] !== undefined) {
      throw new ConnectionSpeedError(400, "下载测速不能包含请求正文");
    }
  } else if (length !== undefined && (!/^[0-9]+$/.test(length) || Number(length) !== bytes)) {
    throw new ConnectionSpeedError(Number(length) > maxSpeedBytes ? 413 : 400, "测速数据长度不匹配");
  }
  return bytes;
}

function consumeUpload(request, expected, signal) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      request.pause();
    };
    const fail = (error) => { cleanup(); reject(error); };
    const onData = (chunk) => {
      received += chunk.length;
      if (received > expected) fail(new ConnectionSpeedError(413, "测速数据超过指定大小"));
    };
    const onEnd = () => {
      cleanup();
      if (received !== expected) reject(new ConnectionSpeedError(400, "测速数据长度不匹配"));
      else resolve();
    };
    const onError = () => fail(new ConnectionSpeedError(400, "测速上传已中断"));
    const onAbort = () => fail(signal.reason);
    if (signal.aborted) return fail(signal.reason);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    request.resume();
  });
}

function send(response, body, contentType, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off("finish", onFinish);
      response.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onFinish = () => { cleanup(); resolve(); };
    const onError = () => { cleanup(); reject(new ConnectionSpeedError(499, "测速连接已关闭")); };
    const onAbort = () => { cleanup(); reject(signal.reason); };
    if (signal.aborted) return onAbort();
    response.once("finish", onFinish);
    response.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    response.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": body.length,
      "Cache-Control": "no-store, no-transform",
    });
    response.end(body);
  });
}

// Test traffic is discarded in memory and never enters item/upload persistence.
// These limits bound simultaneous random buffers and stalled upload sockets.
export function createConnectionSpeed({ timeoutMs = 20_000, maxActive = 8, maxPerSession = 1 } = {}) {
  const active = new Set();
  const sessions = new Map();
  return {
    async transfer(request, response, url, session, verifySession) {
      const bytes = requestedBytes(request, url);
      if (active.size >= maxActive || (sessions.get(session.token) || 0) >= maxPerSession) {
        throw new ConnectionSpeedError(429, "正在进行其他测速，请稍后重试");
      }
      const controller = new AbortController();
      const cancel = () => controller.abort(new ConnectionSpeedError(499, "测速已取消"));
      const timer = setTimeout(() => controller.abort(new ConnectionSpeedError(408, "测速请求超时，请重试")), timeoutMs);
      timer.unref();
      active.add(controller);
      sessions.set(session.token, (sessions.get(session.token) || 0) + 1);
      request.once("aborted", cancel);
      response.once("close", cancel);
      try {
        if (request.destroyed || response.destroyed) cancel();
        controller.signal.throwIfAborted();
        if (request.method === "GET") {
          const body = await randomPayload(bytes);
          controller.signal.throwIfAborted();
          verifySession();
          await send(response, body, "application/octet-stream", controller.signal);
        } else {
          await consumeUpload(request, bytes, controller.signal);
          verifySession();
          await send(response, Buffer.from(JSON.stringify({ bytes })), "application/json; charset=utf-8", controller.signal);
        }
      } finally {
        clearTimeout(timer);
        request.off("aborted", cancel);
        response.off("close", cancel);
        active.delete(controller);
        const remaining = sessions.get(session.token) - 1;
        if (remaining) sessions.set(session.token, remaining);
        else sessions.delete(session.token);
      }
    },
    close() {
      for (const controller of active) controller.abort(new ConnectionSpeedError(503, "服务器正在停止测速"));
    },
  };
}
