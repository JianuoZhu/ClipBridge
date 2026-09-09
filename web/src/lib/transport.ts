/** Browser ↔ home transport. HTTPS remains available while ICE is connecting. */
export type TransportSnapshot = Readonly<{
  mode: "http" | "connecting" | "direct" | "relay" | "unavailable";
  detail: string;
  rttMs?: number;
}>;

const CHUNK_BYTES = 16 * 1024;
const WINDOW_BYTES = 1024 * 1024;
const BUFFER_BYTES = 512 * 1024;
const MAX_REQUESTS = 32;
const CONNECT_TIMEOUT_MS = 15_000;
const RESPONSE_IDLE_TIMEOUT_MS = 90_000;
const listeners = new Set<() => void>();
let snapshot: TransportSnapshot = { mode: "http", detail: "通过 HTTPS 连接家中服务器" };
let active = false;
let generation = 0;
let failures = 0;
let connection: Peer | undefined;
let connecting: AbortController | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let listening = false;

type Peer = {
  pc: RTCPeerConnection;
  control: RTCDataChannel;
  generation: number;
  ready: boolean;
  pending: Set<(error: Error) => void>;
  statsTimer?: ReturnType<typeof setInterval>;
  disconnectTimer?: ReturnType<typeof setTimeout>;
};

export function getTransportSnapshot(): TransportSnapshot { return snapshot; }
export function subscribeTransport(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
export function isDirectTransport(): boolean {
  return Boolean(connection?.ready && (snapshot.mode === "direct" || snapshot.mode === "relay"));
}
function publish(next: TransportSnapshot) {
  if (next.mode === snapshot.mode && next.detail === snapshot.detail && next.rttMs === snapshot.rttMs) return;
  snapshot = Object.freeze(next);
  for (const listener of listeners) listener();
}
function abortError(message = "操作已取消"): DOMException { return new DOMException(message, "AbortError"); }
function isAbort(error: unknown): boolean { return typeof error === "object" && error !== null && "name" in error && error.name === "AbortError"; }
function clearRetry() { if (retryTimer) clearTimeout(retryTimer); retryTimer = undefined; }
function current(peer: Peer): boolean { return active && connection === peer && generation === peer.generation; }
function disposePeer(error: Error) {
  const old = connection;
  connection = undefined;
  if (!old) return;
  old.ready = false;
  clearInterval(old.statsTimer);
  clearTimeout(old.disconnectTimer);
  for (const fail of [...old.pending]) fail(error);
  old.pc.close();
}
function scheduleRetry() {
  if (!active || retryTimer || document.visibilityState === "hidden" || navigator.onLine === false) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (active && !connecting && !connection) void connect();
  }, Math.min(60_000, 2_000 * 2 ** Math.min(failures++, 5)));
}
function lost(peer: Peer, message: string) {
  if (!current(peer)) return;
  disposePeer(new Error("直连已中断，尚未完成的操作请检查结果后重试"));
  publish({ mode: "unavailable", detail: message + "，当前使用 HTTPS" });
  scheduleRetry();
}

async function updateStats(peer: Peer) {
  try {
    const report = await peer.pc.getStats();
    if (!current(peer) || !peer.ready) return;
    let selectedId: string | undefined;
    report.forEach((stat) => { if (stat.type === "transport" && stat.selectedCandidatePairId) selectedId = stat.selectedCandidatePairId; });
    let pair = selectedId ? report.get(selectedId) : undefined;
    if (!pair) report.forEach((stat) => {
      if (stat.type === "candidate-pair" && stat.state === "succeeded" && (stat.selected || stat.nominated)) pair = stat;
    });
    const local = pair && report.get(pair.localCandidateId);
    const remote = pair && report.get(pair.remoteCandidateId);
    // A connected RTCPeerConnection alone does not establish that TURN was avoided.
    if (!pair || !local?.candidateType || !remote?.candidateType) {
      publish({ mode: "connecting", detail: "加密通道已连接，正在确认实际传输路径" });
      return;
    }
    const relay = local.candidateType === "relay" || remote.candidateType === "relay";
    const rttMs = typeof pair.currentRoundTripTime === "number" && Number.isFinite(pair.currentRoundTripTime)
      ? Math.round(pair.currentRoundTripTime * 1_000) : undefined;
    publish({ mode: relay ? "relay" : "direct", detail: relay ? "通过 TURN 中继连接家中服务器" : "已直连家中服务器，数据绕过公网中转", rttMs });
  } catch { /* Stats may be unavailable briefly during ICE negotiation; never guess the route. */ }
}

function gatherIce(pc: RTCPeerConnection, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const finish = () => { clean(); resolve(); };
    const change = () => { if (pc.iceGatheringState === "complete") finish(); };
    const abort = () => { clean(); reject(abortError()); };
    const timeout = setTimeout(finish, 4_000);
    function clean() { clearTimeout(timeout); pc.removeEventListener("icegatheringstatechange", change); signal.removeEventListener("abort", abort); }
    pc.addEventListener("icegatheringstatechange", change);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function connect() {
  if (!active || connecting || connection) return;
  const token = generation;
  const controller = new AbortController();
  connecting = controller;
  const deadline = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  const valid = () => active && generation === token && connecting === controller && !controller.signal.aborted;
  publish({ mode: "connecting", detail: "正在尝试直连家中服务器，当前使用 HTTPS" });
  try {
    const response = await fetch("/api/p2p/config", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (!valid()) return;
    if (!response.ok) throw new Error("无法获取直连配置");
    const config: { enabled?: boolean; iceServers?: RTCIceServer[] } = await response.json();
    if (!valid()) return;
    if (!config.enabled) {
      publish({ mode: "http", detail: "家中服务器尚未启用直连，当前使用 HTTPS" });
      return;
    }
    if (typeof RTCPeerConnection === "undefined") {
      publish({ mode: "unavailable", detail: "此浏览器不支持 WebRTC，当前使用 HTTPS" });
      return;
    }
    const pc = new RTCPeerConnection({ iceServers: config.iceServers || [] });
    const control = pc.createDataChannel("clip-control-v1", { ordered: true });
    const peer: Peer = { pc, control, generation: token, ready: false, pending: new Set() };
    connection = peer;
    const opened = new Promise<void>((resolve, reject) => {
      const abort = () => reject(abortError());
      controller.signal.addEventListener("abort", abort, { once: true });
      control.addEventListener("open", () => { controller.signal.removeEventListener("abort", abort); resolve(); }, { once: true });
      control.addEventListener("close", () => { controller.signal.removeEventListener("abort", abort); reject(new Error("直连通道已关闭")); }, { once: true });
      // Negotiation can fail before this promise is awaited.
    });
    void opened.catch(() => {});
    control.addEventListener("close", () => { if (peer.ready) lost(peer, "直连连接已断开"); });
    control.addEventListener("error", () => { if (peer.ready) lost(peer, "直连连接发生错误"); });
    pc.addEventListener("connectionstatechange", () => {
      if (!current(peer)) return;
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (peer.ready) lost(peer, "直连连接失败");
        else controller.abort();
      } else if (pc.connectionState === "disconnected") {
        peer.ready = false;
        publish({ mode: "connecting", detail: "直连暂时中断，正在恢复；新请求使用 HTTPS" });
        clearTimeout(peer.disconnectTimer);
        peer.disconnectTimer = setTimeout(() => lost(peer, "直连恢复超时"), 10_000);
      } else if (pc.connectionState === "connected" && control.readyState === "open") {
        clearTimeout(peer.disconnectTimer);
        peer.ready = true;
        void updateStats(peer);
      }
    });
    await pc.setLocalDescription(await pc.createOffer());
    await gatherIce(pc, controller.signal);
    if (!valid()) return;
    const answerResponse = await fetch("/api/p2p/offer", {
      method: "POST", credentials: "same-origin", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Clip-Request": "1" },
      body: JSON.stringify({ offer: { type: "offer", sdp: pc.localDescription?.sdp } }),
    });
    if (!valid()) return;
    if (!answerResponse.ok) throw new Error("家中直连服务暂时不可用");
    const answer: { answer: RTCSessionDescriptionInit } = await answerResponse.json();
    if (!valid()) return;
    await pc.setRemoteDescription(answer.answer);
    await opened;
    if (!valid()) return;
    peer.ready = true;
    failures = 0;
    await updateStats(peer);
    if (!valid() || !current(peer) || !peer.ready) return;
    peer.statsTimer = setInterval(() => void updateStats(peer), 10_000);
  } catch (error) {
    if (active && generation === token && connecting === controller) {
      disposePeer(new Error("无法建立家中直连"));
      publish({ mode: "unavailable", detail: isAbort(error) ? "打洞超时，当前使用 HTTPS；稍后自动重试" : "家中直连暂时不可用，当前使用 HTTPS；稍后自动重试" });
      scheduleRetry();
    }
  } finally {
    clearTimeout(deadline);
    if (connecting === controller) connecting = undefined;
    // An abort can race with a fetch that resolves instead of rejecting.
    if (active && generation === token && controller.signal.aborted) {
      disposePeer(new Error("直连建立超时"));
      publish({ mode: "unavailable", detail: "打洞超时，当前使用 HTTPS；稍后自动重试" });
      scheduleRetry();
    }
  }
}

function recover() {
  if (!active || document.visibilityState === "hidden" || navigator.onLine === false) return;
  if (connection?.ready) { void updateStats(connection); return; }
  retryTransport();
}
export function startTransport(): void {
  if (active) return;
  active = true;
  generation++;
  if (!listening) {
    window.addEventListener("online", recover);
    document.addEventListener("visibilitychange", recover);
    listening = true;
  }
  void connect();
}
export function stopTransport(): void {
  active = false;
  generation++;
  clearRetry();
  connecting?.abort();
  connecting = undefined;
  disposePeer(abortError("登录状态已改变，传输已取消"));
  if (listening) {
    window.removeEventListener("online", recover);
    document.removeEventListener("visibilitychange", recover);
    listening = false;
  }
  failures = 0;
  publish({ mode: "http", detail: "通过 HTTPS 连接家中服务器" });
}
export function retryTransport(): void {
  if (!active) return;
  generation++;
  clearRetry();
  connecting?.abort();
  connecting = undefined;
  disposePeer(abortError("正在重新建立直连，原传输已取消"));
  void connect();
}

type BodyPlan = { size: number; chunks: () => AsyncGenerator<Uint8Array<ArrayBuffer>> };
function prepareBody(body: BodyInit | null | undefined): BodyPlan | undefined {
  if (body == null) return { size: 0, async *chunks() {} };
  if (typeof body === "string" || body instanceof URLSearchParams) {
    const bytes = new TextEncoder().encode(String(body));
    return { size: bytes.byteLength, async *chunks() { for (let at = 0; at < bytes.length; at += CHUNK_BYTES) yield bytes.slice(at, at + CHUNK_BYTES); } };
  }
  if (body instanceof Blob) {
    // Slice reads keep memory bounded even for large files and avoid eager Blob conversion.
    return { size: body.size, async *chunks() {
      for (let at = 0; at < body.size; at += CHUNK_BYTES) yield new Uint8Array(await body.slice(at, at + CHUNK_BYTES).arrayBuffer());
    } };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) {
    const bytes = body instanceof ArrayBuffer ? new Uint8Array(body) : new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
    return { size: bytes.byteLength, async *chunks() { for (let at = 0; at < bytes.length; at += CHUNK_BYTES) yield bytes.slice(at, at + CHUNK_BYTES); } };
  }
  // Unknown-size streams and multipart forms use the existing HTTP implementation.
  return undefined;
}

class PeerRequestError extends Error {
  constructor(message: string, readonly sent: boolean, readonly headersReceived: boolean, readonly cause?: Error) { super(message); }
}
function errorValue(error: unknown): Error { return error instanceof Error ? error : new Error("直连传输失败"); }
function nativeOnly(path: string): boolean {
  return !path.startsWith("/api/") || /^\/api\/(?:auth(?:\/|$)|session(?:[/?]|$)|p2p(?:[/?]|$))/.test(path);
}

/** Never replays a sent mutation. A failed GET may use HTTPS only before response headers. */
export async function transportFetch(path: string, options: RequestInit = {}, progress?: (percent: number) => void): Promise<Response> {
  const native = () => fetch(path, { credentials: "same-origin", ...options });
  if (options.signal?.aborted) throw abortError();
  const peer = connection;
  if (nativeOnly(path) || !peer?.ready || !current(peer) || peer.control.readyState !== "open" || peer.pending.size >= MAX_REQUESTS) return native();
  const body = prepareBody(options.body);
  if (!body) return native();
  const method = (options.method || "GET").toUpperCase();
  try { return await requestOverPeer(peer, path, method, options, body, progress); }
  catch (error) {
    if (options.signal?.aborted || generation !== peer.generation || isAbort(error) || (error instanceof PeerRequestError && isAbort(error.cause))) throw abortError();
    if (error instanceof PeerRequestError && !error.headersReceived && (!error.sent || method === "GET" || method === "HEAD")) return native();
    throw error;
  }
}

function requestOverPeer(peer: Peer, path: string, method: string, options: RequestInit, body: BodyPlan, progress?: (percent: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    let channel: RTCDataChannel;
    try { channel = peer.pc.createDataChannel("clip-http-v1", { ordered: true }); }
    catch (error) { reject(new PeerRequestError("无法建立请求通道", false, false, errorValue(error))); return; }
    channel.binaryType = "arraybuffer";
    channel.bufferedAmountLowThreshold = BUFFER_BYTES / 2;
    let sent = false;
    let headersReceived = false;
    let done = false;
    let ended = false;
    let uploadStopped = false;
    let sendCredit = WINDOW_BYTES;
    let receiveCredit = WINDOW_BYTES;
    let demand = false;
    let acceptsResponseBody = true;
    let expectedResponseBytes: number | undefined;
    let receivedResponseBytes = 0;
    let responseController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const queue: Uint8Array[] = [];
    const waiters = new Set<() => void>();
    const wake = () => { for (const waiter of [...waiters]) waiter(); waiters.clear(); };
    let timeout = setTimeout(() => fail(new Error("直连请求超时，请检查操作结果后重试")), body.size ? 60 * 60 * 1_000 : 60_000);
    const abort = () => fail(abortError());
    function responseActivity() {
      if (!headersReceived || ended || done) return;
      clearTimeout(timeout);
      // SSE heartbeats and body consumption renew this deadline. A completed
      // response may still wait for its reader, without losing its buffered tail.
      timeout = setTimeout(() => fail(new Error("直连响应长时间没有进展，请重新读取")), RESPONSE_IDLE_TIMEOUT_MS);
    }
    function clean() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
      peer.pending.delete(fail);
      wake();
    }
    function finish() {
      if (done) return;
      done = true;
      uploadStopped = true;
      clean();
      channel.close();
    }
    function fail(reason: Error) {
      if (done) return;
      const error = isAbort(reason) ? reason : new PeerRequestError(reason.message, sent, headersReceived, reason);
      done = true;
      uploadStopped = true;
      queue.length = 0;
      clean();
      try { responseController?.error(error); } catch { /* Already canceled by the reader. */ }
      reject(error);
      channel.close();
    }
    function sendFrame(frame: object) {
      if (channel.readyState !== "open") throw new Error("直连请求通道已关闭");
      channel.send(JSON.stringify(frame));
    }
    function flush() {
      if (done || !responseController) return;
      if (demand && queue.length) {
        const bytes = queue.shift()!;
        demand = false;
        responseController.enqueue(bytes);
        if (!ended) {
          receiveCredit += bytes.byteLength;
          sendFrame({ type: "credit", bytes: bytes.byteLength });
          responseActivity();
        }
      }
      if (ended && queue.length === 0) { responseController.close(); finish(); }
    }
    async function sendBody() {
      let uploaded = 0;
      try {
        for await (const bytes of body.chunks()) {
          while (!done && !uploadStopped && (sendCredit < bytes.byteLength || channel.bufferedAmount + bytes.byteLength > BUFFER_BYTES)) {
            await new Promise<void>((resume) => waiters.add(resume));
          }
          if (done || uploadStopped) return;
          sendCredit -= bytes.byteLength;
          channel.send(bytes);
          uploaded += bytes.byteLength;
          progress?.(Math.min(99, Math.floor(uploaded / body.size * 100)));
        }
        if (!done && !uploadStopped) sendFrame({ type: "end" });
      } catch (error) { if (!done && !uploadStopped) fail(errorValue(error)); }
    }
    peer.pending.add(fail);
    options.signal?.addEventListener("abort", abort, { once: true });
    channel.addEventListener("bufferedamountlow", wake);
    channel.addEventListener("open", () => {
      if (done || !current(peer) || options.signal?.aborted) { fail(abortError()); return; }
      try {
        const headers = new Headers(options.headers);
        if (!["GET", "HEAD"].includes(method)) headers.set("X-Clip-Request", "1");
        if (!headers.has("Content-Type") && typeof options.body === "string") headers.set("Content-Type", "text/plain;charset=UTF-8");
        if (!headers.has("Content-Type") && options.body instanceof URLSearchParams) headers.set("Content-Type", "application/x-www-form-urlencoded;charset=UTF-8");
        if (!headers.has("Content-Type") && options.body instanceof Blob && options.body.type) headers.set("Content-Type", options.body.type);
        // Set before send: if send throws we cannot prove that a mutation was not observed remotely.
        sent = true;
        sendFrame({ type: "request", method, path, headers: Object.fromEntries(headers), bodySize: body.size });
        void sendBody();
      } catch (error) { fail(errorValue(error)); }
    }, { once: true });
    channel.addEventListener("message", (event: MessageEvent) => {
      if (done) return;
      try {
        if (typeof event.data === "string") {
          if (event.data.length > 64 * 1024) throw new Error("直连响应头超过限制");
          const frame = JSON.parse(event.data);
          if (frame.type === "credit") {
            if (!Number.isSafeInteger(frame.bytes) || frame.bytes <= 0 || sendCredit + frame.bytes > WINDOW_BYTES) throw new Error("直连流量控制无效");
            sendCredit += frame.bytes;
            wake();
          } else if (frame.type === "response") {
            if (headersReceived || !Number.isInteger(frame.status) || frame.status < 200 || frame.status > 599) throw new Error("直连响应格式无效");
            headersReceived = true;
            uploadStopped = true;
            wake();
            clearTimeout(timeout);
            const noBody = method === "HEAD" || [204, 205, 304].includes(frame.status);
            acceptsResponseBody = !noBody;
            const responseHeaders = new Headers(frame.headers);
            const length = responseHeaders.get("Content-Length");
            if (!noBody && length !== null) {
              if (!/^\d+$/.test(length) || !Number.isSafeInteger(Number(length))) throw new Error("直连响应长度无效");
              expectedResponseBytes = Number(length);
            }
            const stream = new ReadableStream<Uint8Array>({
              start(controller) { responseController = controller; },
              pull() { demand = true; try { flush(); } catch (error) { fail(errorValue(error)); } },
              cancel() { finish(); },
            }, { highWaterMark: 0 });
            const response = new Response(noBody ? null : stream, { status: frame.status, headers: responseHeaders });
            response.headers.set("X-Clip-Transport", snapshot.mode === "direct" || snapshot.mode === "relay" ? snapshot.mode : "webrtc");
            responseActivity();
            resolve(response);
          } else if (frame.type === "end") {
            if (!headersReceived || ended) throw new Error("直连响应结束顺序无效");
            if (expectedResponseBytes !== undefined && expectedResponseBytes !== receivedResponseBytes) throw new Error("直连响应不完整，请重新读取");
            ended = true;
            clearTimeout(timeout);
            uploadStopped = true;
            wake();
            if (body.size) progress?.(100);
            flush();
          } else if (frame.type === "error") {
            throw new Error(typeof frame.message === "string" ? frame.message : "家中传输服务返回错误");
          } else throw new Error("未知的直连协议消息");
        } else if (event.data instanceof ArrayBuffer) {
          const bytes = new Uint8Array(event.data);
          if (!headersReceived || ended || !acceptsResponseBody || !responseController || !bytes.byteLength || bytes.byteLength > CHUNK_BYTES || bytes.byteLength > receiveCredit) throw new Error("直连响应数据超过流量限制");
          if (expectedResponseBytes !== undefined && receivedResponseBytes + bytes.byteLength > expectedResponseBytes) throw new Error("直连响应超过声明长度");
          receivedResponseBytes += bytes.byteLength;
          receiveCredit -= bytes.byteLength;
          queue.push(bytes);
          responseActivity();
          flush();
        } else throw new Error("直连响应数据类型无效");
      } catch (error) { fail(errorValue(error)); }
    });
    channel.addEventListener("error", () => fail(new Error("直连传输失败，请检查操作结果后重试")));
    channel.addEventListener("close", () => { if (!ended) fail(new Error("直连传输中断，请检查操作结果后重试")); });
  });
}
