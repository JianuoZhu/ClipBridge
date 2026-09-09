import type { PDFDataRangeTransport } from "pdfjs-dist";
import { ApiError } from "./client";
import { transportFetch } from "./transport";

const CHUNK = 64 * 1024;

/** PDF.js reads requested byte ranges instead of buffering an entire document. */
export async function createPdfSource(
  pdfjs: Pick<typeof import("pdfjs-dist"), "PDFDataRangeTransport">,
  url: string, size: number, signal: AbortSignal, onError: (error: Error) => void,
): Promise<{ range: PDFDataRangeTransport }> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) controller.abort();
  const read = async (begin: number, end: number) => {
    const response = await transportFetch(url, { signal: controller.signal, headers: { Range: `bytes=${begin}-${end - 1}` } });
    if (!response.ok) {
      const payload = await response.json().catch(() => null);
      throw new ApiError(payload?.error || `PDF 读取失败（${response.status}）`, response.status);
    }
    const expected = `bytes ${begin}-${end - 1}/${size}`;
    if (response.status !== 206 || response.headers.get("Content-Range") !== expected) {
      await response.body?.cancel();
      throw new Error("服务器未返回正确的 PDF 范围，请下载后查看");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - begin) throw new Error("PDF 数据不完整，请重试");
    return bytes;
  };
  try {
    const initial = await read(0, Math.min(CHUNK, size));
    class HomeRangeTransport extends pdfjs.PDFDataRangeTransport {
      requestDataRange(begin: number, end: number) {
        if (!Number.isInteger(begin) || !Number.isInteger(end) || begin < 0 || end <= begin || end > size) {
          onError(new Error("PDF 请求范围无效")); return;
        }
        void read(begin, end).then((bytes) => {
          if (!controller.signal.aborted) this.onDataRange(begin, bytes);
        }).catch((error) => {
          if (!controller.signal.aborted) { onError(error instanceof Error ? error : new Error("PDF 读取失败")); this.abort(); }
        });
      }
      abort() { signal.removeEventListener("abort", abort); controller.abort(); }
    }
    return { range: new HomeRangeTransport(size, initial, initial.length === size) };
  } catch (error) {
    signal.removeEventListener("abort", abort); controller.abort(); throw error;
  }
}
