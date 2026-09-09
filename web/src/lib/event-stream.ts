import { getTransportSnapshot, transportFetch } from "./transport";

export type EventStream = Pick<EventTarget, "addEventListener"> & {
  readyState: number;
  close(): void;
  onerror: ((event: Event) => unknown) | null;
};

/** SSE over a streamed DataChannel response; heartbeats do not create events. */
class DirectEventStream extends EventTarget {
  readyState = 0;
  onerror: ((event: Event) => unknown) | null = null;
  private controller = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private retry = 1000;
  private closed = false;

  constructor(private readonly path: string) { super(); void this.connect(); }

  close() {
    this.closed = true; this.readyState = 2;
    clearTimeout(this.timer); this.controller.abort();
  }

  private async connect() {
    if (this.closed) return;
    this.controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await transportFetch(this.path, {
        headers: { Accept: "text/event-stream" }, signal: this.controller.signal,
      });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        throw new Error("实时同步连接失败");
      }
      if (this.closed) { await response.body.cancel(); return; }
      this.readyState = 1; this.retry = 1000;
      this.dispatchEvent(new Event("open"));
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let pending = "";
      const dispatch = (frame: string) => {
        let event = "message";
        const data: string[] = [];
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).replace(/^ /, "");
          if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
        if (data.length) this.dispatchEvent(new MessageEvent(event, { data: data.join("\n") }));
      };
      while (!this.closed) {
        const { value, done } = await reader.read();
        if (done) throw new Error("实时同步连接已断开");
        pending += decoder.decode(value, { stream: true });
        // Keep a trailing CR until the next chunk so split CRLF is normalized correctly.
        pending = pending.replace(/\r\n/g, "\n").replace(/\r(?!$)/g, "\n");
        let boundary: number;
        while ((boundary = pending.indexOf("\n\n")) >= 0) {
          dispatch(pending.slice(0, boundary)); pending = pending.slice(boundary + 2);
        }
        if (pending.length > 256 * 1024) throw new Error("实时同步事件过大");
      }
    } catch {
      if (this.closed) return;
      this.readyState = 0;
      this.onerror?.(new Event("error"));
      if (this.closed) return;
      this.timer = setTimeout(() => void this.connect(), this.retry);
      this.retry = Math.min(15_000, this.retry * 2);
    } finally {
      await reader?.cancel().catch(() => {});
      reader?.releaseLock();
    }
  }
}

export function createEventStream(path: string): EventStream {
  const { mode } = getTransportSnapshot();
  return mode === "direct" || mode === "relay" ? new DirectEventStream(path) : new EventSource(path);
}
