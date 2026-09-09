import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DownloadButton } from "./DownloadButton";
import { downloadFile } from "@/lib/downloads";
import type { PreviewFile } from "@/lib/types";

vi.mock("@/lib/downloads", () => ({ downloadFile: vi.fn() }));
vi.mock("@/lib/transport", () => ({ getTransportSnapshot: () => ({ mode: "direct", detail: "" }) }));
const file: PreviewFile = { scope: "items", id: "file", fileName: "file.bin", size: 4, previewType: null };

describe("download control", () => {
  beforeEach(() => { vi.mocked(downloadFile).mockReset(); });

  it("shows streamed progress and cancels the active download", async () => {
    let pending!: Parameters<typeof downloadFile>[1];
    vi.mocked(downloadFile).mockImplementation((_file, options) => {
      pending = options;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))));
    });
    render(<DownloadButton file={file} label />);
    fireEvent.click(screen.getByRole("link", { name: "下载" }));
    act(() => pending.onProgress?.(42));
    const cancel = screen.getByRole("button", { name: "取消下载（42%）" });
    await act(async () => { fireEvent.click(cancel); });
    expect(pending.signal.aborted).toBe(true);
    expect(screen.getByRole("status")).toHaveTextContent("下载已取消");
    expect(screen.getByRole("link", { name: "下载" })).toBeInTheDocument();
  });

  it("aborts on logout/unmount and ignores late completion notices", async () => {
    let pending!: Parameters<typeof downloadFile>[1];
    vi.mocked(downloadFile).mockImplementation((_file, options) => {
      pending = options;
      return new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError"))));
    });
    const notice = vi.fn();
    const view = render(<DownloadButton file={file} onNotice={notice} />);
    fireEvent.click(screen.getByRole("link", { name: "下载" }));
    await act(async () => { view.unmount(); });
    pending.onRoute?.("direct", "Old session transfer");
    expect(pending.signal.aborted).toBe(true);
    expect(notice).not.toHaveBeenCalled();
  });
});
