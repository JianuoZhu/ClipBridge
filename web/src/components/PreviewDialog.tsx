import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, FileWarning, ImageIcon, LoaderCircle, Maximize2, Minus, Plus } from "lucide-react";
import { Document, Page, pdfjs } from "react-pdf";
import type { PDFDataRangeTransport, PDFDocumentProxy } from "pdfjs-dist";
import { TransformComponent, TransformWrapper } from "react-zoom-pan-pinch";
import type { PreviewFile } from "@/lib/types";
import { createThumbnailController, loadImagePreview, previewUrl } from "@/lib/thumbnails";
import { createPdfSource } from "@/lib/pdf-source";
import { ApiError } from "@/lib/client";
import { DownloadButton } from "./DownloadButton";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import "./preview.css";
import "react-pdf/dist/Page/TextLayer.css";

pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
const MAX_PDF = 100 * 1024 * 1024;

export function PreviewDialog({ file, sessionKey = 0, onClose, onUnauthorized }: { file: PreviewFile | null; sessionKey?: number; onClose: () => void; onUnauthorized?: () => void }) {
  const [pages, setPages] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fit, setFit] = useState(true);
  const [width, setWidth] = useState(760);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const [imageSrc, setImageSrc] = useState("");
  const [pdfSource, setPdfSource] = useState<{ range: PDFDataRangeTransport } | null>(null);
  const passwordCallback = useRef<((password: string) => void) | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPages(0); setPage(1); setZoom(1); setFit(true); setError(""); setNeedsPassword(false); setPassword(""); passwordCallback.current = null;
    setImageSrc(""); setPdfSource(null);
    if (!file) return;
    const controller = createThumbnailController();
    let range: PDFDataRangeTransport | undefined;
    const failed = (reason: Error) => {
      if (controller.signal.aborted) return;
      if (reason instanceof ApiError && reason.status === 401) onUnauthorized?.();
      setError(file.previewType === "pdf"
        ? `PDF 暂时无法打开：${reason.message || "请重试或下载查看。"}`
        : reason.message || "内容暂时无法预览，请下载查看。");
      setPdfSource(null);
    };
    if (file.previewType === "image") {
      void loadImagePreview(file, sessionKey, controller.signal).then((url) => {
        if (!controller.signal.aborted) setImageSrc(url);
      }).catch(failed);
    } else if (file.previewType === "pdf" && file.size <= MAX_PDF) {
      void createPdfSource(pdfjs, previewUrl(file), file.size, controller.signal, failed).then((source) => {
        range = source.range;
        if (controller.signal.aborted) range.abort(); else setPdfSource(source);
      }).catch(failed);
    }
    return () => { controller.abort(); range?.abort(); };
  }, [file, sessionKey, onUnauthorized]);
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(260, Math.min(1100, entry.contentRect.width - 48))));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [file]);
  const options = useMemo(() => ({
    withCredentials: true, disableRange: false, disableAutoFetch: true, disableStream: true,
    cMapUrl: "/pdfjs/cmaps/", cMapPacked: true, standardFontDataUrl: "/pdfjs/standard_fonts/",
    wasmUrl: "/pdfjs/wasm/", isEvalSupported: false
  }), []);
  const loaded = useCallback((document: PDFDocumentProxy) => { setPages(document.numPages); setError(""); }, []);
  if (!file) return null;
  const downloadableOnly = file.previewType === "pdf" && file.size > MAX_PDF;
  const submitPassword = (event: React.FormEvent) => {
    event.preventDefault();
    if (!password || !passwordCallback.current) return;
    const update = passwordCallback.current;
    passwordCallback.current = null;
    setNeedsPassword(false);
    update(password);
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="preview-dialog">
        <DialogHeader>
          <DialogTitle>{file.fileName}</DialogTitle>
          <DialogDescription>{file.previewType === "pdf" ? "PDF 文档" : "图片"} · 内容来自家中节点，退出登录后清除预览缓存</DialogDescription>
        </DialogHeader>
        {file.previewType === "image" ? (
          <TransformWrapper centerOnInit minScale={.35} maxScale={6} wheel={{ step: .12 }} doubleClick={{ mode: "toggle" }}>
            {({ zoomIn, zoomOut, resetTransform }) => <>
              <div className="preview-toolbar">
                <Button variant="secondary" size="icon" onClick={() => zoomOut()} aria-label="缩小"><Minus size={17} /></Button>
                <Button variant="secondary" size="icon" onClick={() => resetTransform()} aria-label="适应窗口"><Maximize2 size={17} /></Button>
                <Button variant="secondary" size="icon" onClick={() => zoomIn()} aria-label="放大"><Plus size={17} /></Button>
                <DownloadButton file={file} label />
              </div>
              <TransformComponent wrapperClass="image-stage" contentClass="image-content">
                {imageSrc ? <img src={imageSrc} alt={file.fileName} onError={() => setError("图片暂时无法预览，请下载查看。")} /> : !error && <div className="preview-state"><LoaderCircle className="spin" />正在读取图片…</div>}
              </TransformComponent>
            </>}
          </TransformWrapper>
        ) : downloadableOnly ? (
          <div className="preview-state"><FileWarning /><strong>这个 PDF 超过 100 MB</strong><span>为了避免浏览器占用过多内存，请下载后查看。</span><DownloadButton file={file} label /></div>
        ) : (
          <>
            <div className="preview-toolbar">
              <Button variant="secondary" size="icon" onClick={() => setPage((value) => Math.max(1, value - 1))} disabled={page <= 1} aria-label="上一页"><ChevronLeft size={17} /></Button>
              <label className="page-field"><span className="sr-only">页码</span><input type="number" min={1} max={pages || 1} value={page} onChange={(event) => setPage(Math.min(pages || 1, Math.max(1, Number(event.target.value))))} /><span>/ {pages || "—"}</span></label>
              <Button variant="secondary" size="icon" onClick={() => setPage((value) => Math.min(pages, value + 1))} disabled={!pages || page >= pages} aria-label="下一页"><ChevronRight size={17} /></Button>
              <Button variant="secondary" size="icon" onClick={() => { setFit(false); setZoom((value) => Math.max(.5, value - .15)); }} aria-label="缩小"><Minus size={17} /></Button>
              <Button variant={fit ? "default" : "secondary"} size="sm" onClick={() => setFit(true)}>适应宽度</Button>
              <Button variant="secondary" size="icon" onClick={() => { setFit(false); setZoom((value) => Math.min(3, value + .15)); }} aria-label="放大"><Plus size={17} /></Button>
              <DownloadButton file={file} label />
            </div>
            <div ref={stage} className="pdf-stage">
              {pdfSource ? <Document file={pdfSource} options={options}
                onLoadSuccess={loaded}
                onLoadError={(reason) => {
                  const status = (reason as { status?: number }).status;
                  if (status === 401) onUnauthorized?.();
                  setError("PDF 暂时无法打开，请重试或下载查看。");
                }}
                onPassword={(callback) => { passwordCallback.current = callback; setNeedsPassword(true); }}
                loading={<div className="preview-state"><LoaderCircle className="spin" />正在读取 PDF…</div>}
                error={<div className="preview-state"><FileWarning />{error || "PDF 暂时无法打开"}</div>}>
                {!needsPassword && <Page pageNumber={page} width={fit ? width : undefined} scale={fit ? undefined : zoom}
                  devicePixelRatio={Math.min(window.devicePixelRatio || 1, 2)}
                  renderAnnotationLayer={false} renderTextLayer
                  loading={<div className="page-skeleton" />} />}
              </Document> : <div className="preview-state">{error ? <><FileWarning />{error}</> : <><LoaderCircle className="spin" />正在读取 PDF…</>}</div>}
            </div>
          </>
        )}
        {needsPassword && <form className="password-panel" onSubmit={submitPassword}><ImageIcon /><label>此 PDF 已加密<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="输入文档密码" /></label><Button type="submit">解锁预览</Button></form>}
        {error && file.previewType === "image" && <p className="inline-error">{error}</p>}
      </DialogContent>
    </Dialog>
  );
}
