/** Browser ↔ home transport. HTTPS remains available while ICE is connecting. */
export type NegotiationStage = "config" | "create-offer" | "gathering" | "offer" | "ice" | "connected" | "disabled" | "unsupported";
type CandidateType = "host" | "srflx" | "prflx" | "relay";
type CandidateCounts = Readonly<Record<CandidateType, number>>;
type PeerDiagnostics = Readonly<{
  connectionState?: RTCPeerConnectionState;
  iceConnectionState?: RTCIceConnectionState;
  iceGatheringState?: RTCIceGatheringState;
  localCandidates: CandidateCounts;
  remoteCandidates: CandidateCounts;
}>;
export type TransportDiagnostics = PeerDiagnostics & Readonly<{
  attemptStartedAt: string;
  stage: NegotiationStage;
  enabled?: boolean;
  configHttpStatus?: number;
  offerHttpStatus?: number;
  gatheringTimedOut?: boolean;
  stunErrorCodes?: readonly number[];
  selectedPair?: Readonly<{ local: CandidateType; remote: CandidateType }>;
  errorCode?: string;
  lastFailure?: PeerDiagnostics & Readonly<{
    at: string; stage: NegotiationStage; code: string; configHttpStatus?: number; offerHttpStatus?: number;
  }>;
}>;
export type TransportSnapshot = Readonly<{
  mode: "http" | "connecting" | "direct" | "relay" | "unavailable";
  detail: string;
  rttMs?: number;
  diagnostics?: TransportDiagnostics;
}>;

const errorDetails: Record<string, string> = {
  P2P_DISABLED: "家中服务器未启用直连；请检查 CLIP_P2P_ENABLED 并重新创建服务。",
  P2P_UNSUPPORTED: "此浏览器不支持 WebRTC；请使用支持 WebRTC 的浏览器并检查浏览器策略。",
  P2P_SESSION_REQUIRED: "登录状态已失效或请求被拒绝；请刷新页面并重新登录。",
  P2P_CONFIG_HTTP: "网站未能返回直连配置；请检查 /api/p2p/config 的 HTTP 状态及网站服务日志。",
  P2P_CONFIG_NETWORK: "无法通过 HTTPS 取得直连配置；请检查网站连接及反向代理。",
  P2P_CONFIG_TIMEOUT: "取得直连配置超时；请先检查网站 HTTPS 链路。",
  P2P_CONFIG_INVALID: "网站返回了无效的直连配置；请确认前后端均已更新。",
  P2P_INVALID_OFFER: "连接协商请求无效；请更新前后端并重新尝试。",
  P2P_RATE_LIMITED: "直连尝试过于频繁；请稍候，系统会自动重试。",
  P2P_GATEWAY_UNREACHABLE: "网站无法访问家庭 P2P 网关；请检查网关是否运行及内部地址、端口。",
  P2P_GATEWAY_TIMEOUT: "家庭 P2P 网关响应超时；请检查网关日志和家庭服务器负载。",
  P2P_GATEWAY_AUTH_FAILED: "网站与 P2P 网关的密钥不一致；请统一 CLIP_P2P_SECRET 并重新创建两项服务。",
  P2P_ICE_GATHER_TIMEOUT: "家庭网关采集候选地址超时；请检查家中 STUN 访问及网关日志。",
  P2P_GATEWAY_BUSY: "家庭 P2P 网关连接数已满；请稍候重试并检查网关负载。",
  P2P_GATEWAY_REJECTED: "家庭 P2P 网关拒绝了协商；请核对网关日志及前后端版本。",
  P2P_GATEWAY_BAD_ANSWER: "家庭 P2P 网关返回了无效的协商结果；请检查网关版本与日志。",
  P2P_NEGOTIATION_CANCELLED: "连接协商已取消；请重新尝试。",
  P2P_OFFER_HTTP: "网站未能完成连接协商；请查看 /api/p2p/offer 的 HTTP 状态及服务日志。",
  P2P_OFFER_NETWORK: "连接协商请求未能通过 HTTPS 完成；请检查网站及反向代理日志。",
  P2P_OFFER_TIMEOUT: "连接协商阶段耗尽了连接时间；请检查网站延迟及网关的候选采集日志。",
  P2P_OFFER_INVALID: "浏览器无法应用网关的协商结果；请检查前后端版本及网关日志。",
  P2P_BROWSER_NEGOTIATION: "浏览器无法创建 WebRTC 连接；请检查浏览器的 WebRTC 策略和扩展。",
  P2P_GATHER_TIMEOUT: "浏览器采集候选地址时耗尽了连接时间；请检查本机网络及 STUN 可达性。",
  P2P_ICE_TIMEOUT: "协商成功，但打洞未在时间内完成；请对比同 Wi-Fi 与蜂窝网络，并检查家庭 UDP、防火墙和 NAT。",
  P2P_ICE_FAILED: "浏览器与家庭节点的 ICE 连接失败；请检查双方候选类型、家庭 UDP、防火墙和 NAT。",
  P2P_CHANNEL_CLOSED: "加密数据通道已关闭；请检查家庭网关日志和网络稳定性。",
};
export function transportErrorDetail(code: string): string {
  return errorDetails[code] || "家中直连暂不可用；请查看连接诊断和家庭网关日志。";
}
class NegotiationError extends Error {
  constructor(readonly code: string) { super(transportErrorDetail(code)); }
}
const emptyCandidates = (): CandidateCounts => ({ host: 0, srflx: 0, prflx: 0, relay: 0 });
function candidateType(value: unknown): CandidateType | undefined {
  return value === "host" || value === "srflx" || value === "prflx" || value === "relay" ? value : undefined;
}
function countCandidates(sdp?: string): CandidateCounts {
  const counts = { ...emptyCandidates() };
  for (const line of sdp?.split(/\r?\n/) || []) {
    if (!line.startsWith("a=candidate:")) continue;
    const type = candidateType(/\styp\s+(\w+)(?:\s|$)/.exec(line)?.[1]);
    if (type) counts[type]++;
  }
  return counts;
}
function peerDiagnostics(pc: RTCPeerConnection): PeerDiagnostics {
  return {
    connectionState: pc.connectionState, iceConnectionState: pc.iceConnectionState, iceGatheringState: pc.iceGatheringState,
    localCandidates: countCandidates(pc.localDescription?.sdp), remoteCandidates: countCandidates(pc.remoteDescription?.sdp),
  };
}

async function responseErrorCode(response: Response, fallback: string): Promise<string> {
  if (response.status === 401 || response.status === 403) return "P2P_SESSION_REQUIRED";
  try {
    const body: unknown = await response.json();
    const code = typeof body === "object" && body !== null && "code" in body ? body.code : undefined;
    // Only known codes cross into diagnostics. Server error text may include private data.
    if (typeof code === "string" && Object.hasOwn(errorDetails, code)) return code;
  } catch { /* A reverse proxy may return HTML instead of the API error envelope. */ }
  return fallback;
}

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
  const diagnostics = Object.hasOwn(next, "diagnostics") ? next.diagnostics : snapshot.diagnostics;
  if (next.mode === snapshot.mode && next.detail === snapshot.detail && next.rttMs === snapshot.rttMs && diagnostics === snapshot.diagnostics) return;
  snapshot = Object.freeze({ ...next, diagnostics });
  for (const listener of listeners) listener();
}
function diagnose(patch: Partial<TransportDiagnostics>) {
  if (!snapshot.diagnostics) return;
  publish({ ...snapshot, diagnostics: Object.freeze({ ...snapshot.diagnostics, ...patch }) });
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
  const facts = peerDiagnostics(peer.pc);
  diagnose({ ...facts, errorCode: "P2P_CHANNEL_CLOSED", lastFailure: {
    ...facts, at: new Date().toISOString(), stage: "connected", code: "P2P_CHANNEL_CLOSED",
    configHttpStatus: snapshot.diagnostics?.configHttpStatus, offerHttpStatus: snapshot.diagnostics?.offerHttpStatus,
  } });
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
    const localType = candidateType(local?.candidateType);
    const remoteType = candidateType(remote?.candidateType);
    diagnose({ ...peerDiagnostics(peer.pc), stage: "connected", selectedPair: localType && remoteType ? { local: localType, remote: remoteType } : undefined, errorCode: undefined });
    // A connected RTCPeerConnection alone does not establish that TURN was avoided.
    if (!pair || !localType || !remoteType) {
      publish({ mode: "connecting", detail: "加密通道已连接，正在确认实际传输路径" });
      return;
    }
    const relay = local.candidateType === "relay" || remote.candidateType === "relay";
    const rttMs = typeof pair.currentRoundTripTime === "number" && Number.isFinite(pair.currentRoundTripTime)
      ? Math.round(pair.currentRoundTripTime * 1_000) : undefined;
    publish({ mode: relay ? "relay" : "direct", detail: relay ? "通过 TURN 中继连接家中服务器" : "已直连家中服务器，数据绕过公网中转", rttMs });
  } catch { /* Stats may be unavailable briefly during ICE negotiation; never guess the route. */ }
}

function gatherIce(pc: RTCPeerConnection, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.reject(abortError());
  if (pc.iceGatheringState === "complete") return Promise.resolve(true);
  return new Promise((resolve, reject) => {
    const finish = () => { clean(); resolve(pc.iceGatheringState === "complete"); };
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
  let stage: NegotiationStage = "config";
  let abortCode: string | undefined;
  let failed = false;
  // Slow HTTPS signaling must not consume the time available for ICE itself.
  // Each phase has a deadline; a complete attempt remains bounded by 30 seconds.
  let deadline = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  const valid = () => active && generation === token && connecting === controller && !controller.signal.aborted;
  const setStage = (next: NegotiationStage) => { stage = next; diagnose({ stage: next }); };
  const fail = (error: unknown) => {
    if (failed || !active || generation !== token || connecting !== controller) return;
    failed = true;
    const timeoutCodes: Partial<Record<NegotiationStage, string>> = {
      config: "P2P_CONFIG_TIMEOUT", gathering: "P2P_GATHER_TIMEOUT", offer: "P2P_OFFER_TIMEOUT", ice: "P2P_ICE_TIMEOUT",
    };
    const defaultCodes: Partial<Record<NegotiationStage, string>> = {
      config: "P2P_CONFIG_NETWORK", offer: "P2P_OFFER_NETWORK", ice: "P2P_OFFER_INVALID",
    };
    const code = error instanceof NegotiationError ? error.code : abortCode || (controller.signal.aborted
      ? timeoutCodes[stage] || "P2P_BROWSER_NEGOTIATION" : defaultCodes[stage] || "P2P_BROWSER_NEGOTIATION");
    const facts = connection ? peerDiagnostics(connection.pc) : { localCandidates: emptyCandidates(), remoteCandidates: emptyCandidates() };
    diagnose({ ...facts, stage, errorCode: code, lastFailure: {
      ...facts, at: new Date().toISOString(), stage, code,
      configHttpStatus: snapshot.diagnostics?.configHttpStatus, offerHttpStatus: snapshot.diagnostics?.offerHttpStatus,
    } });
    disposePeer(new Error("无法建立家中直连"));
    publish({ mode: "unavailable", detail: transportErrorDetail(code) + " 当前使用 HTTPS，稍后自动重试。" });
    scheduleRetry();
  };
  publish({ mode: "connecting", detail: "正在尝试直连家中服务器，当前使用 HTTPS", diagnostics: {
    attemptStartedAt: new Date().toISOString(), stage,
    localCandidates: emptyCandidates(), remoteCandidates: emptyCandidates(), lastFailure: snapshot.diagnostics?.lastFailure,
  } });
  try {
    const response = await fetch("/api/p2p/config", { credentials: "same-origin", cache: "no-store", signal: controller.signal });
    if (!valid()) return;
    diagnose({ configHttpStatus: response.status });
    if (!response.ok) throw new NegotiationError(await responseErrorCode(response, "P2P_CONFIG_HTTP"));
    let config: { enabled?: boolean; iceServers?: RTCIceServer[] };
    try {
      config = await response.json();
      if (!config || typeof config.enabled !== "boolean" || (config.iceServers !== undefined && !Array.isArray(config.iceServers))) throw new Error();
    } catch { throw new NegotiationError("P2P_CONFIG_INVALID"); }
    if (!valid()) return;
    diagnose({ enabled: config.enabled });
    if (!config.enabled) {
      setStage("disabled");
      diagnose({ errorCode: "P2P_DISABLED" });
      publish({ mode: "http", detail: transportErrorDetail("P2P_DISABLED") + " 当前使用 HTTPS。" });
      return;
    }
    if (typeof RTCPeerConnection === "undefined") {
      setStage("unsupported");
      diagnose({ errorCode: "P2P_UNSUPPORTED" });
      publish({ mode: "unavailable", detail: transportErrorDetail("P2P_UNSUPPORTED") + " 当前使用 HTTPS。" });
      return;
    }
    setStage("create-offer");
    const pc = new RTCPeerConnection({ iceServers: config.iceServers || [] });
    const control = pc.createDataChannel("clip-control-v1", { ordered: true });
    const peer: Peer = { pc, control, generation: token, ready: false, pending: new Set() };
    connection = peer;
    const changed = () => { if (current(peer)) diagnose(peerDiagnostics(pc)); };
    pc.addEventListener("iceconnectionstatechange", changed);
    pc.addEventListener("icegatheringstatechange", changed);
    pc.addEventListener("icecandidate", changed);
    pc.addEventListener("icecandidateerror", (event) => {
      if (!current(peer) || !Number.isInteger(event.errorCode)) return;
      const codes = snapshot.diagnostics?.stunErrorCodes || [];
      if (!codes.includes(event.errorCode)) diagnose({ stunErrorCodes: [...codes, event.errorCode].slice(0, 8) });
    });
    changed();
    const opened = new Promise<void>((resolve, reject) => {
      const abort = () => reject(abortError());
      controller.signal.addEventListener("abort", abort, { once: true });
      control.addEventListener("open", () => { controller.signal.removeEventListener("abort", abort); resolve(); }, { once: true });
      control.addEventListener("close", () => { controller.signal.removeEventListener("abort", abort); reject(new NegotiationError("P2P_CHANNEL_CLOSED")); }, { once: true });
      // Negotiation can fail before this promise is awaited.
    });
    void opened.catch(() => {});
    control.addEventListener("close", () => { if (peer.ready) lost(peer, "直连连接已断开"); });
    control.addEventListener("error", () => { if (peer.ready) lost(peer, "直连连接发生错误"); });
    pc.addEventListener("connectionstatechange", () => {
      if (!current(peer)) return;
      changed();
      if (pc.connectionState === "failed" || pc.connectionState === "closed") {
        if (peer.ready) lost(peer, "直连连接失败");
        else { abortCode = "P2P_ICE_FAILED"; controller.abort(); }
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
    if (!valid()) return;
    setStage("gathering");
    const gathered = await gatherIce(pc, controller.signal);
    if (!valid()) return;
    diagnose({ ...peerDiagnostics(pc), gatheringTimedOut: !gathered });
    setStage("offer");
    const answerResponse = await fetch("/api/p2p/offer", {
      method: "POST", credentials: "same-origin", signal: controller.signal,
      headers: { "Content-Type": "application/json", "X-Clip-Request": "1" },
      body: JSON.stringify({ offer: { type: "offer", sdp: pc.localDescription?.sdp } }),
    });
    if (!valid()) return;
    diagnose({ offerHttpStatus: answerResponse.status });
    if (!answerResponse.ok) throw new NegotiationError(await responseErrorCode(answerResponse, "P2P_OFFER_HTTP"));
    let answer: { answer: RTCSessionDescriptionInit };
    try {
      answer = await answerResponse.json();
      if (!answer?.answer || answer.answer.type !== "answer" || typeof answer.answer.sdp !== "string") throw new Error();
    } catch { throw new NegotiationError("P2P_OFFER_INVALID"); }
    if (!valid()) return;
    clearTimeout(deadline);
    deadline = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    setStage("ice");
    await pc.setRemoteDescription(answer.answer);
    if (!valid()) return;
    diagnose(peerDiagnostics(pc));
    await opened;
    if (!valid()) return;
    peer.ready = true;
    failures = 0;
    await updateStats(peer);
    if (!valid() || !current(peer) || !peer.ready) return;
    peer.statsTimer = setInterval(() => void updateStats(peer), 10_000);
  } catch (error) {
    fail(error);
  } finally {
    clearTimeout(deadline);
    // An abort can race with a fetch that resolves instead of rejecting.
    if (controller.signal.aborted) fail(abortError());
    if (connecting === controller) connecting = undefined;
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
  publish({ mode: "http", detail: "通过 HTTPS 连接家中服务器", diagnostics: undefined });
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
