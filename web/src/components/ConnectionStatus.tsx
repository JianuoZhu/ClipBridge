import { useState, useSyncExternalStore } from "react";
import { Link2, LoaderCircle, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { getTransportSnapshot, retryTransport, subscribeTransport } from "@/lib/transport";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";

const labels = {
  direct: "家中直连", relay: "中继连接", connecting: "正在建立直连", http: "HTTPS 备用", unavailable: "HTTPS 备用",
};

export function ConnectionStatus({ connection }: { connection: "online" | "offline" | "connecting" }) {
  const transport = useSyncExternalStore(subscribeTransport, getTransportSnapshot);
  const [open, setOpen] = useState(false);
  const Icon = transport.mode === "connecting" ? LoaderCircle : transport.mode === "direct" ? Link2 : connection === "offline" ? WifiOff : Wifi;
  return <>
    <button type="button" className={`connection connection-button ${connection} transport-${transport.mode}`}
      onClick={() => setOpen(true)} aria-label={`连接状态：${labels[transport.mode]}，${connection === "online" ? "同步正常" : connection === "offline" ? "同步中断" : "同步连接中"}`}>
      <Icon className={transport.mode === "connecting" ? "spin" : ""} /><span>{labels[transport.mode]}</span>
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="connection-dialog">
        <DialogHeader><DialogTitle>当前连接</DialogTitle><DialogDescription>这台设备与家中服务器的传输路径</DialogDescription></DialogHeader>
        <div className={`connection-path transport-${transport.mode}`}><span>当前设备</span><Icon /><strong>家中服务器</strong></div>
        <dl className="connection-details">
          <div><dt>传输方式</dt><dd>{labels[transport.mode]}</dd></div>
          <div><dt>实时同步</dt><dd>{connection === "online" ? "正常" : connection === "connecting" ? "正在连接" : "连接中断，正在重试"}</dd></div>
          {transport.rttMs !== undefined && <div><dt>连接往返延迟</dt><dd>{Math.round(transport.rttMs)} ms</dd></div>}
        </dl>
        <p className="connection-explanation">{transport.mode === "direct" ? "文字、文件与预览可直接传到家中，绕过公网中转。网页、登录和连接协商仍使用 HTTPS。" : transport.mode === "relay" ? "直连暂不可用，当前通过 WebRTC 中继传输，速度受中继链路限制。" : transport.mode === "connecting" ? "正在尝试与家中节点打洞。在直连就绪前，使用现有 HTTPS 路径。" : "当前使用网站 HTTPS 路径。直连不可用时仍可发送和读取家中保存的内容。"}</p>
        {transport.detail && <p className="connection-detail">{transport.detail}</p>}
        <p className="connection-explanation">显示“已保存到家中”后，发送设备即可下线。另一台设备会独立建立自己的连接。大文件下载的浏览器兼容回退会单独提示。</p>
        <Button variant="outline" onClick={() => void retryTransport()} disabled={transport.mode === "connecting"}><RefreshCw size={16} />重新尝试直连</Button>
      </DialogContent>
    </Dialog>
  </>;
}
