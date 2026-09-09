import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfSource } from "./pdf-source";
import { transportFetch } from "./transport";

vi.mock("./transport", () => ({ transportFetch: vi.fn() }));
class FakeRange {
  onDataRange = vi.fn();
  constructor(readonly length: number, readonly initialData: Uint8Array, readonly progressiveDone: boolean) {}
}
const pdfjs = { PDFDataRangeTransport: FakeRange } as unknown as Parameters<typeof createPdfSource>[0];

describe("PDF byte range source", () => {
  beforeEach(() => { vi.mocked(transportFetch).mockReset(); });

  it("loads the first chunk and only requests additional ranges on demand", async () => {
    const size = 200_000;
    vi.mocked(transportFetch).mockImplementation(async (_path, init) => {
      const [, begin, end] = new Headers(init?.headers).get("Range")!.match(/bytes=(\d+)-(\d+)/)!;
      return new Response(new Uint8Array(Number(end) - Number(begin) + 1), {
        status: 206, headers: { "Content-Range": `bytes ${begin}-${end}/${size}` },
      });
    });
    const error = vi.fn();
    const { range } = await createPdfSource(pdfjs, "/api/items/pdf/preview", size, new AbortController().signal, error);
    expect((range as unknown as FakeRange).initialData.byteLength).toBe(65_536);
    expect(transportFetch).toHaveBeenCalledOnce();
    range.requestDataRange(100_000, 110_000);
    await vi.waitFor(() => expect(range.onDataRange).toHaveBeenCalledWith(100_000, expect.any(Uint8Array)));
    expect(transportFetch).toHaveBeenCalledTimes(2);
    range.abort();
    expect(error).not.toHaveBeenCalled();
  });

  it("rejects ignored or mismatched ranges so a full document cannot be mistaken for a fragment", async () => {
    const cancel = vi.fn();
    vi.mocked(transportFetch).mockResolvedValue(new Response(new ReadableStream({ cancel }), { status: 200 }));
    await expect(createPdfSource(pdfjs, "/pdf", 200_000, new AbortController().signal, vi.fn())).rejects.toThrow("正确的 PDF 范围");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("aborts all in-flight ranges when the preview/session closes", async () => {
    vi.mocked(transportFetch).mockResolvedValueOnce(new Response(new Uint8Array(65_536), { status: 206, headers: { "Content-Range": "bytes 0-65535/200000" } }));
    const controller = new AbortController();
    const error = vi.fn();
    const { range } = await createPdfSource(pdfjs, "/pdf", 200_000, controller.signal, error);
    vi.mocked(transportFetch).mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
    }));
    range.requestDataRange(100_000, 110_000);
    controller.abort();
    await Promise.resolve(); await Promise.resolve();
    expect(vi.mocked(transportFetch).mock.calls[1][1]?.signal?.aborted).toBe(true);
    expect(error).not.toHaveBeenCalled();
  });
});
