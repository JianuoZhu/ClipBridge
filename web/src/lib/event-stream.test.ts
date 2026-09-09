import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEventStream } from "./event-stream";
import { getTransportSnapshot, transportFetch } from "./transport";

vi.mock("./transport", () => ({ getTransportSnapshot: vi.fn(), transportFetch: vi.fn() }));
const tick = async () => { for (let index = 0; index < 8; index += 1) await Promise.resolve(); };

describe("streamed real-time events", () => {
  beforeEach(() => { vi.mocked(getTransportSnapshot).mockReturnValue({ mode: "direct", detail: "" }); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("parses split UTF-8 and CRLF frames, multiline data, and ignores heartbeats", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.mocked(transportFetch).mockResolvedValue(new Response(new ReadableStream({ start(controller) { stream = controller; } }), {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const source = createEventStream("/api/events");
    const events: string[] = [];
    const messages = vi.fn();
    source.addEventListener("items", (event) => events.push((event as MessageEvent).data));
    source.addEventListener("message", messages);
    const bytes = new TextEncoder().encode(': heartbeat\r\n\r\nevent: items\r\ndata: {"text":"你好"}\r\ndata: second\r\n\r\n');
    for (const byte of bytes) stream.enqueue(new Uint8Array([byte]));
    await tick();
    // One byte per asynchronous read needs one turn per byte.
    for (let index = 0; index < bytes.length; index += 1) await Promise.resolve();
    expect(events).toEqual(['{"text":"你好"}\nsecond']);
    expect(messages).not.toHaveBeenCalled();
    expect(source.readyState).toBe(1);
    source.close();
    expect(source.readyState).toBe(2);
  });

  it("reconnects an ended stream but cancels retries when the session closes", async () => {
    vi.useFakeTimers();
    vi.mocked(transportFetch).mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
      headers: { "Content-Type": "text/event-stream" },
    }));
    const source = createEventStream("/api/events");
    const error = vi.fn(); source.onerror = error;
    await tick();
    expect(error).toHaveBeenCalledOnce();
    expect(source.readyState).toBe(0);
    source.close();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(transportFetch).toHaveBeenCalledOnce();
    expect(vi.mocked(transportFetch).mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("keeps the native EventSource route while direct transport is unavailable", () => {
    vi.mocked(getTransportSnapshot).mockReturnValue({ mode: "http", detail: "" });
    const Native = vi.fn(function () { return { close() {}, readyState: 0 }; });
    vi.stubGlobal("EventSource", Native);
    createEventStream("/api/events").close();
    expect(Native).toHaveBeenCalledWith("/api/events");
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it("does not schedule a reconnect when an error callback signs the user out", async () => {
    vi.useFakeTimers();
    vi.mocked(transportFetch).mockRejectedValue(new Error("Session expired"));
    const source = createEventStream("/api/events");
    source.onerror = () => source.close();
    await tick();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(source.readyState).toBe(2);
    expect(transportFetch).toHaveBeenCalledOnce();
  });
});
