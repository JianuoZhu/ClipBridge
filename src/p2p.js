// The public API only negotiates connections. Credentials remain on the home node;
// every tunneled request is authenticated again by the existing HTTP handlers.
export class P2pError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

function gatewayError(status) {
  if (status === 401 || status === 403) return new P2pError(503, "P2P_GATEWAY_AUTH_FAILED", "家中直连密钥不匹配，请检查应用与网关配置；当前使用 HTTPS");
  if (status === 504) return new P2pError(503, "P2P_ICE_GATHER_TIMEOUT", "家中节点收集网络地址超时，请检查 STUN 与 UDP 出站连接；当前使用 HTTPS");
  if (status === 503) return new P2pError(503, "P2P_GATEWAY_BUSY", "家中直连网关繁忙或无法分配连接，请检查网关日志；当前使用 HTTPS");
  return new P2pError(503, "P2P_GATEWAY_REJECTED", "家中直连网关拒绝协商，请检查网关日志；当前使用 HTTPS");
}

export function createP2pSignaling(config = {}) {
  const pending = new Set();
  const attempts = new Map();
  let closed = false;
  return {
    configuration() {
      return { enabled: config.enabled === true, iceServers: config.enabled && config.stunUrls?.length ? [{ urls: config.stunUrls }] : [] };
    },
    async offer({ body, session, cookieName, host, signal }) {
      if (closed || !config.enabled) throw new P2pError(503, "P2P_DISABLED", "家中直连尚未启用，继续使用 HTTPS");
      if (body?.offer?.type !== "offer" || typeof body.offer.sdp !== "string" ||
          body.offer.sdp.length > 96 * 1024 || !body.offer.sdp.startsWith("v=0") ||
          !body.offer.sdp.includes("m=application ") || /(?:^|\n)m=(?:audio|video) /.test(body.offer.sdp)) {
        throw new P2pError(400, "P2P_INVALID_OFFER", "无效的数据连接协商请求");
      }
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until <= now && entry.active === 0) attempts.delete(key);
      let entry = attempts.get(session.token);
      if (!entry) {
        if (attempts.size >= 2048) throw new P2pError(429, "P2P_RATE_LIMITED", "连接请求过多，请稍后重试");
        entry = { until: now + 60_000, count: 0, active: 0 };
        attempts.set(session.token, entry);
      }
      if (entry.until <= now) { entry.until = now + 60_000; entry.count = 0; }
      if (entry.active >= 2 || entry.count >= 12 || pending.size >= 16) throw new P2pError(429, "P2P_RATE_LIMITED", "连接请求过多，请稍后重试");
      entry.count += 1; entry.active += 1;
      const controller = new AbortController();
      const timeout = AbortSignal.timeout(10_000);
      let receivedResponse = false;
      pending.add(controller);
      try {
        const response = await fetch(`${config.gatewayUrl}/offer`, {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
          body: JSON.stringify({ offer: { type: "offer", sdp: body.offer.sdp },
            cookie: `${cookieName}=${session.token}`, host,
            expiresAt: Math.min(session.expires_at, now + 30 * 60 * 1000) }),
          signal: AbortSignal.any([controller.signal, timeout, ...(signal ? [signal] : [])]),
        });
        receivedResponse = true;
        if (!response.ok) { await response.body?.cancel().catch(() => {}); throw gatewayError(response.status); }
        // The gateway is local and trusted, but still bound its signaling response.
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > 128 * 1024) { await reader.cancel(); throw new Error("Oversized answer"); }
            chunks.push(value);
          }
        } finally { reader.releaseLock(); }
        const answer = JSON.parse(Buffer.concat(chunks).toString("utf8")).answer;
        if (answer?.type !== "answer" || typeof answer.sdp !== "string" || !answer.sdp.startsWith("v=0")) throw new Error("Invalid answer");
        return { answer: { type: "answer", sdp: answer.sdp } };
      } catch (error) {
        if (error instanceof P2pError) throw error;
        if (timeout.aborted) throw new P2pError(503, "P2P_GATEWAY_TIMEOUT", "家中直连网关响应超时，请检查网关日志；当前使用 HTTPS");
        if (controller.signal.aborted || signal?.aborted) throw new P2pError(503, "P2P_NEGOTIATION_CANCELLED", "直连协商已取消，当前使用 HTTPS");
        if (receivedResponse) throw new P2pError(503, "P2P_GATEWAY_BAD_ANSWER", "家中直连网关返回了无效响应，请检查版本与网关日志；当前使用 HTTPS");
        throw new P2pError(503, "P2P_GATEWAY_UNREACHABLE", "无法连接家中直连网关，请检查服务是否启动及内部连接地址；当前使用 HTTPS");
      } finally { entry.active -= 1; pending.delete(controller); }
    },
    close() { closed = true; for (const controller of pending) controller.abort(); pending.clear(); attempts.clear(); },
  };
}
