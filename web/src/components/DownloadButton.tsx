import { useEffect, useRef, useState } from "react";
import { Download, LoaderCircle, X } from "lucide-react";
import { downloadFile } from "@/lib/downloads";
import { downloadUrl } from "@/lib/thumbnails";
import { getTransportSnapshot } from "@/lib/transport";
import type { PreviewFile } from "@/lib/types";
import { Button } from "./ui/button";

export function DownloadButton({ file, label = false, onNotice }: {
  file: PreviewFile; label?: boolean; onNotice?: (message: string, error?: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => {
    const pending = controller.current;
    controller.current = null;
    pending?.abort();
  }, []);
  const notice = (message: string, error = false) => { setStatus(message); onNotice?.(message, error); };
  const download = async () => {
    if (controller.current) return;
    const aborter = new AbortController();
    controller.current = aborter;
    setBusy(true); setProgress(0);
    try {
      await downloadFile(file, {
        signal: aborter.signal,
        onProgress: (value) => { if (controller.current === aborter) setProgress(value); },
        onRoute: (_route, detail) => { if (controller.current === aborter) notice(detail); },
      });
    } catch (error) {
      if (controller.current !== aborter) return;
      if ((error as Error).name === "AbortError") notice("下载已取消");
      else notice(error instanceof Error ? error.message : "下载失败，请重试", true);
    } finally {
      if (controller.current === aborter) { controller.current = null; setBusy(false); }
    }
  };
  return <span className="download-control">
    {busy ? <Button size={label ? "default" : "icon"} variant="outline" onClick={() => controller.current?.abort()} aria-label={`取消下载（${progress}%）`} title={`正在下载 ${progress}% · 点击取消`}>
      <LoaderCircle className="spin" size={16} />{label && `${progress}%`}<X className="download-cancel" size={10} />
    </Button> : <Button asChild size={label ? "default" : "icon"} variant="outline"><a href={downloadUrl(file)} download={file.fileName} aria-label="下载" onClick={(event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const mode = getTransportSnapshot().mode;
      if (mode !== "direct" && mode !== "relay") { notice("已交给浏览器，通过 HTTPS 下载"); return; }
      event.preventDefault(); void download();
    }}><Download size={16} />{label && "下载"}</a></Button>}
    {status && !onNotice && <span className="download-status" role="status">{status}</span>}
  </span>;
}
