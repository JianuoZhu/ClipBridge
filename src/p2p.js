// The public API only negotiates connections. Credentials remain on the home node;
// every tunneled request is authenticated again by the existing HTTP handlers.
export class P2pError extends Error {
  constructor(status, message) { super(message); this.status = status; }
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
      if (closed || !config.enabled) throw new P2pError(503, "家中直连尚未启用，继续使用 HTTPS");
      if (body?.offer?.type !== "offer" || typeof body.offer.sdp !== "string" ||
          body.offer.sdp.length > 96 * 1024 || !body.offer.sdp.startsWith("v=0") ||
          !body.offer.sdp.includes("m=application ") || /(?:^|\n)m=(?:audio|video) /.test(body.offer.sdp)) {
        throw new P2pError(400, "无效的数据连接协商请求");
      }
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until <= now && entry.active === 0) attempts.delete(key);
      let entry = attempts.get(session.token);
      if (!entry) {
        if (attempts.size >= 2048) throw new P2pError(429, "连接请求过多，请稍后重试");
        entry = { until: now + 60_000, count: 0, active: 0 };
        attempts.set(session.token, entry);
      }
      if (entry.until <= now) { entry.until = now + 60_000; entry.count = 0; }
      if (entry.active >= 2 || entry.count >= 12 || pending.size >= 16) throw new P2pError(429, "连接请求过多，请稍后重试");
      entry.count += 1; entry.active += 1;
      const controller = new AbortController();
      pending.add(controller);
      try {
        const response = await fetch(`${config.gatewayUrl}/offer`, {
          method: "POST", redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.secret}` },
          body: JSON.stringify({ offer: { type: "offer", sdp: body.offer.sdp },
            cookie: `${cookieName}=${session.token}`, host,
            expiresAt: Math.min(session.expires_at, now + 30 * 60 * 1000) }),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000), ...(signal ? [signal] : [])]),
        });
        if (!response.ok) { await response.body?.cancel(); throw new P2pError(503, "家中直连暂不可用，继续使用 HTTPS"); }
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
        throw new P2pError(503, "家中直连暂不可用，继续使用 HTTPS");
      } finally { entry.active -= 1; pending.delete(controller); }
    },
    close() { closed = true; for (const controller of pending) controller.abort(); pending.clear(); attempts.clear(); },
  };
}
