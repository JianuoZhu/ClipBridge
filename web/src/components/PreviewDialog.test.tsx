import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PreviewDialog } from "./PreviewDialog";
import { createPdfSource } from "@/lib/pdf-source";
import { ApiError } from "@/lib/client";
import type { PreviewFile } from "@/lib/types";

vi.mock("react-pdf", () => ({ Document: vi.fn(), Page: vi.fn(), pdfjs: { GlobalWorkerOptions: {} } }));
vi.mock("@/lib/pdf-source", () => ({ createPdfSource: vi.fn() }));
const file: PreviewFile = { scope: "items", id: "broken", fileName: "broken.pdf", size: 19, previewType: "pdf" };

describe("PDF preview errors", () => {
  it("shows the same PDF error state for failures before the renderer starts and keeps download available", async () => {
    vi.mocked(createPdfSource).mockRejectedValue(new ApiError("此文件无法作为 PDF 预览，请下载查看", 415));
    render(<PreviewDialog file={file} onClose={vi.fn()} />);
    expect(await screen.findByText("PDF 暂时无法打开：此文件无法作为 PDF 预览，请下载查看")).toBeVisible();
    expect(screen.getByRole("link", { name: "下载" })).toHaveAttribute("href", "/api/items/broken/file");
    expect(screen.queryByText("正在读取 PDF…")).not.toBeInTheDocument();
  });
});
