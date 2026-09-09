import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadFile, MAX_BLOB_DOWNLOAD } from "./downloads";
import { getTransportSnapshot, transportFetch } from "./transport";
import type { PreviewFile } from "./types";

vi.mock("./transport", () => ({ getTransportSnapshot: vi.fn(), transportFetch: vi.fn() }));
const file: PreviewFile = { scope: "items", id: "sample", fileName: "sample.bin", size: 4, previewType: null };
const pickerWindow = window as Window & { showSaveFilePicker?: unknown };

describe("file download routes", () => {
  beforeEach(() => {
    vi.mocked(getTransportSnapshot).mockReturnValue({ mode: "direct", detail: "" });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    delete pickerWindow.showSaveFilePicker;
  });
  afterEach(() => { delete pickerWindow.showSaveFilePicker; vi.useRealTimers(); });

  it("uses native HTTPS for large files when streaming save is unavailable", async () => {
    const onRoute = vi.fn();
    await downloadFile({ ...file, size: MAX_BLOB_DOWNLOAD + 1 }, { signal: new AbortController().signal, onRoute });
    expect(transportFetch).not.toHaveBeenCalled();
    expect(onRoute).toHaveBeenCalledWith("http", expect.stringContaining("64 MB"));
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
  });

  it("reports the actual HTTPS route after a read-only direct request falls back", async () => {
    vi.useFakeTimers();
    const onRoute = vi.fn();
    const onProgress = vi.fn();
    vi.mocked(transportFetch).mockResolvedValue(new Response(new Uint8Array(4), { headers: { "X-Clip-Transport": "http" } }));
    await downloadFile(file, { signal: new AbortController().signal, onRoute, onProgress });
    expect(onRoute).toHaveBeenCalledWith("http", "通过 HTTPS 下载");
    expect(onProgress).toHaveBeenLastCalledWith(100);
    expect(HTMLAnchorElement.prototype.click).toHaveBeenCalledOnce();
    await vi.runAllTimersAsync();
  });

  it("aborts the destination and rejects truncated transfers instead of committing a partial file", async () => {
    const abort = vi.fn();
    const close = vi.fn();
    pickerWindow.showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => new WritableStream({ write() {}, abort, close }) }));
    vi.mocked(transportFetch).mockResolvedValue(new Response(new Uint8Array(3), { headers: { "X-Clip-Transport": "direct" } }));
    await expect(downloadFile(file, { signal: new AbortController().signal })).rejects.toThrow("文件传输不完整");
    expect(abort).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("does not start network I/O after a cancelled save picker", async () => {
    pickerWindow.showSaveFilePicker = vi.fn(async () => { throw new DOMException("Cancelled", "AbortError"); });
    await expect(downloadFile(file, { signal: new AbortController().signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(transportFetch).not.toHaveBeenCalled();
  });

  it("rejects an already-cancelled download even on the native HTTPS route", async () => {
    vi.mocked(getTransportSnapshot).mockReturnValue({ mode: "http", detail: "" });
    const controller = new AbortController(); controller.abort();
    await expect(downloadFile(file, { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });
});
