import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTransportSnapshot, isDirectTransport, retryTransport, startTransport, stopTransport, subscribeTransport, transportFetch } from "./transport";

const CHUNK = 16 * 1024;
const WINDOW = 1024 * 1024;
const encoder = new TextEncoder();

class Channel extends EventTarget {
  readyState: RTCDataChannelState = "connecting";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  sent: (string | Uint8Array)[] = [];
  constructor(readonly label: string) { super(); }
  open() { this.readyState = "open"; this.dispatchEvent(new Event("open")); }
  send(value: string | Uint8Array) {
    if (this.readyState !== "open") throw new Error("closed");
    this.sent.push(value);
  }
  close() { if (this.readyState === "closed") return; this.readyState = "closed"; this.dispatchEvent(new Event("close")); }
  frame(value: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(value) })); }
  bytes(value: Uint8Array) { this.dispatchEvent(new MessageEvent("message", { data: new Uint8Array(value).buffer })); }
  frames() { return this.sent.filter((value): value is string => typeof value === "string").map((value) => JSON.parse(value)); }
  binary() { return this.sent.filter((value): value is Uint8Array => typeof value !== "string"); }
  reply(text = "ok", status = 200) {
    this.frame({ type: "response", status, headers: { "content-type": "text/plain" } });
    if (text) this.bytes(encoder.encode(text));
    this.frame({ type: "end" });
  }
}

class Peer extends EventTarget {
  static all: Peer[] = [];
  static route: "host" | "relay" | "unknown" = "host";
  static autoOpenRequest = true;
  channels: Channel[] = [];
  localDescription = { type: "offer", sdp: "v=0\r\na=candidate:test" };
  iceGatheringState = "complete";
  connectionState = "new";
  constructor() { super(); Peer.all.push(this); }
  createDataChannel(label: string) {
    const channel = new Channel(label);
    this.channels.push(channel);
    if (label === "clip-http-v1" && Peer.autoOpenRequest) queueMicrotask(() => channel.open());
    return channel;
  }
  async createOffer() { return this.localDescription; }
  async setLocalDescription() {}
  async setRemoteDescription() {
    this.connectionState = "connected";
    this.channels[0].open();
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  async getStats() {
    if (Peer.route === "unknown") return new Map();
    return new Map([
      ["transport", { type: "transport", selectedCandidatePairId: "pair" }],
      ["pair", { type: "candidate-pair", state: "succeeded", localCandidateId: "local", remoteCandidateId: "remote", currentRoundTripTime: 0.025 }],
      ["local", { type: "local-candidate", candidateType: Peer.route }],
      ["remote", { type: "remote-candidate", candidateType: "srflx" }],
    ]);
  }
  close() {
    this.connectionState = "closed";
    for (const channel of this.channels) channel.close();
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  get request() { return this.channels[this.channels.length - 1]; }
}

async function settle(turns = 30) { for (let index = 0; index < turns; index++) await Promise.resolve(); }
async function connected(route: "host" | "relay" | "unknown" = "host") {
  Peer.route = route;
  startTransport();
  await settle();
  expect(Peer.all).toHaveLength(1);
  return Peer.all[0];
}
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stopTransport();
  Peer.all = [];
  Peer.route = "host";
  Peer.autoOpenRequest = true;
  vi.stubGlobal("RTCPeerConnection", Peer);
  fetchMock = vi.fn(async (path: string) => {
    if (path === "/api/p2p/config") return Response.json({ enabled: true, iceServers: [{ urls: "stun:example.test" }] });
    if (path === "/api/p2p/offer") return Response.json({ answer: { type: "answer", sdp: "v=0" } });
    return new Response("http fallback");
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => { stopTransport(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("home transport lifecycle", () => {
  it("keeps HTTPS available when the home gateway is disabled", async () => {
    fetchMock.mockImplementation(async () => Response.json({ enabled: false }));
    startTransport();
    await settle();
    expect(getTransportSnapshot().mode).toBe("http");
    expect(Peer.all).toHaveLength(0);
    await transportFetch("/api/items");
    expect(fetchMock).toHaveBeenLastCalledWith("/api/items", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("reports selected candidate stats and keeps snapshots stable between updates", async () => {
    const listener = vi.fn();
    const unsubscribe = subscribeTransport(listener);
    await connected();
    expect(getTransportSnapshot()).toMatchObject({ mode: "direct", rttMs: 25 });
    expect(getTransportSnapshot()).toBe(getTransportSnapshot());
    expect(isDirectTransport()).toBe(true);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("identifies TURN and never infers direct connectivity from an open channel alone", async () => {
    await connected("relay");
    expect(getTransportSnapshot().mode).toBe("relay");
    stopTransport();
    Peer.all = [];
    await connected("unknown");
    expect(getTransportSnapshot().mode).toBe("connecting");
    expect(isDirectTransport()).toBe(false);
  });

  it("always sends session, authentication, and signaling requests through HTTPS", async () => {
    const peer = await connected();
    for (const path of ["/api/session", "/api/auth/login", "/api/auth/logout", "/api/p2p/config", "/api/p2p/offer", "https://example.test/file"]) {
      await transportFetch(path, { method: "POST" });
      expect(fetchMock).toHaveBeenLastCalledWith(path, expect.objectContaining({ method: "POST" }));
    }
    expect(peer.channels).toHaveLength(1);
  });

  it("ignores a late configuration result after logout", async () => {
    let finish!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; }));
    startTransport();
    stopTransport();
    finish(Response.json({ enabled: true }));
    await settle();
    expect(Peer.all).toHaveLength(0);
    expect(getTransportSnapshot().mode).toBe("http");
  });

  it("does not resurrect stats polling when logout races with initial stats collection", async () => {
    vi.useFakeTimers();
    const finish: (() => void)[] = [];
    vi.spyOn(Peer.prototype, "getStats").mockImplementation(() => new Promise((resolve) => {
      finish.push(() => resolve(new Map()));
    }));
    startTransport();
    await settle();
    expect(finish.length).toBeGreaterThan(0);
    stopTransport();
    for (const resolve of finish) resolve();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(getTransportSnapshot().mode).toBe("http");
  });

  it("bounds a stalled handshake and retries without requiring a page reload", async () => {
    vi.useFakeTimers();
    fetchMock.mockImplementationOnce((_path, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")));
    }));
    startTransport();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(getTransportSnapshot().mode).toBe("unavailable");
    await vi.advanceTimersByTimeAsync(2_000);
    expect(getTransportSnapshot().mode).toBe("direct");
  });

  it("cancels an outstanding response when the authenticated session changes", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/events");
    await settle();
    peer.request.frame({ type: "response", status: 200, headers: { "content-type": "text/event-stream" } });
    const response = await pending;
    const read = response.body!.getReader().read();
    const rejected = expect(read).rejects.toMatchObject({ name: "AbortError" });
    stopTransport();
    await rejected;
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/events")).toHaveLength(0);
  });

  it("explicit retry invalidates the old peer and creates a fresh connection", async () => {
    const peer = await connected();
    retryTransport();
    await settle();
    expect(peer.connectionState).toBe("closed");
    expect(Peer.all).toHaveLength(2);
    expect(getTransportSnapshot().mode).toBe("direct");
  });
});

describe("HTTP-over-WebRTC request safety", () => {
  it("falls back for a GET that fails before response headers", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items");
    await settle();
    peer.request.close();
    const response = await pending;
    expect(await response.text()).toBe("http fallback");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items")).toHaveLength(1);
  });

  it("does not replay a mutation after its initial frame may have reached the server", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/text", { method: "POST", body: JSON.stringify({ text: "save once" }) });
    const rejected = expect(pending).rejects.toThrow("直连传输中断");
    await settle();
    expect(peer.request.frames()[0]).toMatchObject({ type: "request", method: "POST", bodySize: 20, headers: { "x-clip-request": "1" } });
    peer.request.close();
    await rejected;
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items/text")).toHaveLength(0);
  });

  it("can fall back for a mutation whose channel never opened", async () => {
    const peer = await connected();
    Peer.autoOpenRequest = false;
    const pending = transportFetch("/api/items/text", { method: "POST", body: "save once" });
    expect(peer.request.frames()).toHaveLength(0);
    peer.request.close();
    expect(await (await pending).text()).toBe("http fallback");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items/text")).toHaveLength(1);
  });

  it("does not replay a mutation even when sending its initial frame throws", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/text", { method: "POST", body: "save once" });
    const rejected = expect(pending).rejects.toThrow("send failed");
    vi.spyOn(peer.request, "send").mockImplementation(() => { throw new Error("send failed"); });
    await rejected;
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items/text")).toHaveLength(0);
  });

  it("does not append HTTPS bytes after a partial direct response", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/example/file");
    await settle();
    peer.request.frame({ type: "response", status: 200, headers: {} });
    peer.request.bytes(encoder.encode("partial"));
    const response = await pending;
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("partial");
    peer.request.close();
    await expect(reader.read()).rejects.toThrow("直连传输中断");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items/example/file")).toHaveLength(0);
  });

  it("marks only an actual data-channel response with its transport route", async () => {
    const peer = await connected("relay");
    const pending = transportFetch("/api/items");
    await settle();
    peer.request.reply("saved");
    const response = await pending;
    expect(response.headers.get("x-clip-transport")).toBe("relay");
    expect(await response.text()).toBe("saved");
    expect(peer.request.readyState).toBe("closed");
  });

  it("canceling one request preserves other requests and the peer", async () => {
    const peer = await connected();
    const controller = new AbortController();
    const first = transportFetch("/api/items/one/file", { signal: controller.signal });
    const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
    await settle();
    const firstChannel = peer.request;
    const second = transportFetch("/api/items/two/file");
    await settle();
    controller.abort();
    await rejected;
    peer.request.reply("second file");
    expect(await (await second).text()).toBe("second file");
    expect(firstChannel.readyState).toBe("closed");
    expect(getTransportSnapshot().mode).toBe("direct");
  });

  it("uses HTTPS beyond the channel cap and releases slots after cancellation", async () => {
    const peer = await connected();
    const pending = Array.from({ length: 32 }, (_, index) => transportFetch(`/api/items?offset=${index}`));
    await settle();
    for (const channel of peer.channels.slice(1)) channel.frame({ type: "response", status: 200, headers: {} });
    const responses = await Promise.all(pending);
    expect(peer.channels).toHaveLength(33);
    expect(await (await transportFetch("/api/items?offset=32")).text()).toBe("http fallback");
    await responses[0].body!.cancel();
    const next = transportFetch("/api/items?offset=33");
    await settle();
    peer.request.reply("direct slot reused");
    expect(await (await next).text()).toBe("direct slot reused");
    await Promise.all(responses.slice(1).map((response) => response.body!.cancel()));
    expect(peer.channels.filter((channel) => channel.readyState === "open")).toHaveLength(1);
  });

  it("rejects incomplete and oversized responses without replaying them through HTTPS", async () => {
    const peer = await connected();
    for (const [length, expectedError] of [[8, "不完整"], [2, "超过声明长度"]] as const) {
      const pending = transportFetch("/api/items/example/file");
      await settle();
      peer.request.frame({ type: "response", status: 200, headers: { "content-length": String(length) } });
      const response = await pending;
      peer.request.bytes(encoder.encode("test"));
      peer.request.frame({ type: "end" });
      await expect(response.text()).rejects.toThrow(expectedError);
    }
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items/example/file")).toHaveLength(0);
  });

  it("accepts HEAD content lengths without expecting response body bytes", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/example/file", { method: "HEAD" });
    await settle();
    peer.request.frame({ type: "response", status: 200, headers: { "content-length": "5000000" } });
    peer.request.frame({ type: "end" });
    const response = await pending;
    expect(response.body).toBeNull();
    expect(response.headers.get("content-length")).toBe("5000000");
    expect(peer.request.readyState).toBe("closed");
  });
});

describe("bounded streaming and credit flow control", () => {
  it("splits uploads into 16 KiB chunks and pauses at the initial 1 MiB credit window", async () => {
    const peer = await connected();
    const controller = new AbortController();
    const progress = vi.fn();
    const pending = transportFetch("/api/items/file", { method: "POST", body: new Uint8Array(2 * WINDOW), signal: controller.signal }, progress);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await settle(400);
    expect(peer.request.binary()).toHaveLength(WINDOW / CHUNK);
    expect(peer.request.binary().every((bytes) => bytes.byteLength === CHUNK)).toBe(true);
    peer.request.frame({ type: "credit", bytes: 4 * CHUNK });
    await settle(40);
    expect(peer.request.binary()).toHaveLength(WINDOW / CHUNK + 4);
    expect(progress.mock.calls.every(([percent]) => percent < 100)).toBe(true);
    controller.abort();
    await rejected;
  });

  it("observes the SCTP send buffer in addition to application credit", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/file", { method: "POST", body: new Uint8Array(CHUNK) });
    const channel = peer.request;
    channel.bufferedAmount = 512 * 1024;
    await settle();
    expect(channel.binary()).toHaveLength(0);
    channel.bufferedAmount = 0;
    channel.dispatchEvent(new Event("bufferedamountlow"));
    await settle();
    expect(channel.binary()).toHaveLength(1);
    channel.reply("saved");
    expect(await (await pending).text()).toBe("saved");
  });

  it("returns download credit only when the caller consumes bytes", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/example/file");
    await settle();
    const channel = peer.request;
    channel.frame({ type: "response", status: 200, headers: {} });
    for (let index = 0; index < WINDOW / CHUNK; index++) channel.bytes(new Uint8Array(CHUNK));
    expect(channel.frames().filter((frame) => frame.type === "credit")).toHaveLength(0);
    const response = await pending;
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toHaveLength(CHUNK);
    expect(channel.frames().filter((frame) => frame.type === "credit")).toEqual([{ type: "credit", bytes: CHUNK }]);
    await reader.cancel();
    expect(channel.readyState).toBe("closed");
  });

  it("rejects a peer that exceeds its advertised receive window", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/example/file");
    await settle();
    const channel = peer.request;
    channel.frame({ type: "response", status: 200, headers: {} });
    const response = await pending;
    for (let index = 0; index <= WINDOW / CHUNK; index++) channel.bytes(new Uint8Array(CHUNK));
    await expect(response.text()).rejects.toThrow("流量限制");
    expect(channel.readyState).toBe("closed");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items/example/file")).toHaveLength(0);
  });

  it("stops reading an upload when the server rejects it early", async () => {
    const peer = await connected();
    const pending = transportFetch("/api/items/file", { method: "POST", body: new Uint8Array(2 * WINDOW) });
    await settle(400);
    const channel = peer.request;
    const before = channel.binary().length;
    channel.reply("too large", 413);
    expect((await pending).status).toBe(413);
    await settle(100);
    expect(channel.binary()).toHaveLength(before);
  });

  it("keeps SSE response streams alive after the ordinary header timeout", async () => {
    vi.useFakeTimers();
    const peer = await connected();
    const pending = transportFetch("/api/events");
    await settle();
    const channel = peer.request;
    channel.frame({ type: "response", status: 200, headers: { "content-type": "text/event-stream" } });
    const response = await pending;
    const reader = response.body!.getReader();
    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(30_000);
      channel.bytes(encoder.encode(": heartbeat\n\n"));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(": heartbeat\n\n");
    }
    await reader.cancel();
  });

  it("releases a stalled response without silently switching its body to HTTPS", async () => {
    vi.useFakeTimers();
    const peer = await connected();
    const pending = transportFetch("/api/items/example/file");
    await settle();
    peer.request.frame({ type: "response", status: 200, headers: {} });
    const response = await pending;
    const rejected = expect(response.text()).rejects.toThrow("长时间没有进展");
    await vi.advanceTimersByTimeAsync(90_000);
    await rejected;
    expect(peer.request.readyState).toBe("closed");
    expect(fetchMock.mock.calls.filter(([path]) => path === "/api/items/example/file")).toHaveLength(0);
  });

  it("preserves a completed response tail when its reader waits beyond the idle timeout", async () => {
    vi.useFakeTimers();
    const peer = await connected();
    const pending = transportFetch("/api/items/example/file");
    await settle();
    peer.request.reply("completed file");
    const response = await pending;
    // The gateway may close an idle channel after sending all frames. The data
    // already received remains readable and no credit needs to be sent back.
    peer.request.close();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(await response.text()).toBe("completed file");
  });
});
