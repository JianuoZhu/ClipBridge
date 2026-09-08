import { useEffect, useRef, useState } from "react";
import { File, FileImage, FileLock2, FileText, LoaderCircle, RotateCcw } from "lucide-react";
import type { PreviewFile } from "@/lib/types";
import { createThumbnailController, loadPdfThumbnail, previewUrl } from "@/lib/thumbnails";
import { cn } from "@/lib/utils";

export function Thumbnail({ file, sessionKey, onClick }: { file: PreviewFile; sessionKey: number; onClick?: () => void }) {
  const root = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "error" | "locked">("idle");
  const [src, setSrc] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!root.current || !("IntersectionObserver" in window)) { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: "180px" });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setSrc("");
    setState(visible && file.previewType === "image" ? "loading" : "idle");
  }, [file.id, file.previewType, file.revision, file.scope, retry, visible]);
  useEffect(() => {
    if (!visible || file.previewType !== "pdf" || file.size > 20 * 1024 * 1024) return;
    const controller = createThumbnailController();
    setState("loading");
    void loadPdfThumbnail(file, sessionKey, controller.signal).then((url) => {
      if (!controller.signal.aborted) { setSrc(url); setState("ready"); }
    }).catch((error) => {
      if (controller.signal.aborted) return;
      setState(error?.name === "PasswordException" ? "locked" : "error");
    });
    return () => controller.abort();
  }, [file, retry, sessionKey, visible]);
  const interactive = Boolean(onClick && file.previewType && file.previewType !== "text");
  const imageSrc = previewUrl(file) + (previewUrl(file).includes("?") ? "&" : "?") + "thumbnail=" + retry;
  const content = file.previewType === "image" && visible ? (
    <img src={imageSrc} alt="" loading="lazy" onLoad={() => setState("ready")} onError={() => setState("error")} />
  ) : state === "ready" ? <img src={src} alt="" /> :
    state === "loading" ? <LoaderCircle className="spin" aria-hidden="true" /> :
    state === "locked" ? <FileLock2 aria-hidden="true" /> :
    file.previewType === "pdf" && file.size > 20 * 1024 * 1024 ? <FileText aria-hidden="true" /> :
    file.previewType === "image" ? <FileImage aria-hidden="true" /> :
    file.previewType === "text" ? <FileText aria-hidden="true" /> : <File aria-hidden="true" />;
  return (
    <button ref={root} type="button" className={cn("thumbnail", interactive && "thumbnail-interactive", state === "loading" && "thumbnail-loading")}
      onClick={state === "error" ? () => setRetry((value) => value + 1) : interactive ? onClick : undefined}
      disabled={!interactive} aria-label={state === "error" ? "重试加载 " + file.fileName : interactive ? "预览 " + file.fileName : undefined}>
      {content}
      {state === "error" && <span className="thumbnail-retry"><RotateCcw size={13} />重试</span>}
      {state === "locked" && <span className="thumbnail-caption">打开后输入密码</span>}
      {file.previewType === "pdf" && file.size > 20 * 1024 * 1024 && <span className="thumbnail-caption">PDF</span>}
    </button>
  );
}
