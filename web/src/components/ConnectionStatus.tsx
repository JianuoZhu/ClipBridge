import { useState, useSyncExternalStore } from "react";
import { Copy, Link2, LoaderCircle, RefreshCw, Wifi, WifiOff } from "lucide-react";
import { getTransportSnapshot, retryTransport, subscribeTransport, transportErrorDetail, type NegotiationStage, type TransportDiagnostics } from "@/lib/transport";
import { Button } from "./ui/button";
import { ConnectionLatency } from "./ConnectionLatency";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import "./connection-status.css";

const labels = {
  direct: "家中直连", relay: "中继连接", connecting: "正在建立直连", http: "HTTPS 备用", unavailable: "HTTPS 备用",
};
const stageLabels: Record<NegotiationStage, string> = {
  config: "读取网站配置", "create-offer": "创建浏览器连接", gathering: "浏览器采集候选地址", offer: "家庭网关协商",
  ice: "ICE 打洞与加密通道", connected: "通道已连接", disabled: "服务未启用", unsupported: "浏览器不支持",
};
function counts(value: TransportDiagnostics["localCandidates"]): string {
  return `host ${value.host} · srflx ${value.srflx} · prflx ${value.prflx} · relay ${value.relay}`;
}
function Diagnostics({ value }: { value: TransportDiagnostics }) {
  const [copied, setCopied] = useState<"idle" | "copied" | "manual">("idle");
  const text = JSON.stringify({ version: 1, ...value }, null, 2);
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied("copied"); }
    catch { setCopied("manual"); }
  }
  return <details className="connection-diagnostics">
    <summary>排查详情</summary>
    <dl>
      <div><dt>当前阶段</dt><dd>{stageLabels[value.stage]}</dd></div>
      <div><dt>本次尝试</dt><dd>{new Date(value.attemptStartedAt).toLocaleString()}</dd></div>
      <div><dt>直连配置</dt><dd>{value.enabled === undefined ? "尚未取得" : value.enabled ? "已启用" : "未启用"}</dd></div>
      <div><dt>配置 / 协商 HTTP</dt><dd>{value.configHttpStatus ?? "—"} / {value.offerHttpStatus ?? "—"}</dd></div>
      {value.errorCode && <div><dt>当前错误码</dt><dd><code>{value.errorCode}</code></dd></div>}
      <div><dt>浏览器 / ICE / 采集</dt><dd>{value.connectionState ?? "—"} / {value.iceConnectionState ?? "—"} / {value.iceGatheringState ?? "—"}</dd></div>
      <div><dt>本机候选</dt><dd>{counts(value.localCandidates)}</dd></div>
      <div><dt>家庭候选</dt><dd>{counts(value.remoteCandidates)}</dd></div>
      {value.selectedPair && <div><dt>实际选中路径</dt><dd>{value.selectedPair.local} ↔ {value.selectedPair.remote}</dd></div>}
      {value.gatheringTimedOut && <div><dt>浏览器候选采集</dt><dd>4 秒内未完成；本次协商使用已取得的候选</dd></div>}
      {!!value.stunErrorCodes?.length && <div><dt>STUN 错误码</dt><dd>{value.stunErrorCodes.join(", ")}</dd></div>}
    </dl>
    {value.lastFailure && <div className="connection-last-failure">
      <strong>最近一次失败 · {stageLabels[value.lastFailure.stage]}</strong>
      <span>{new Date(value.lastFailure.at).toLocaleString()} · <code>{value.lastFailure.code}</code></span>
      <p>{transportErrorDetail(value.lastFailure.code)}</p>
    </div>}
    <p>候选类型用于定位打洞阶段，单独出现 host 或 srflx 并不能证明网络可达。诊断不含 IP、SDP、Cookie 或密钥。</p>
    <Button variant="outline" onClick={() => void copy()}><Copy size={15} />复制诊断信息</Button>
    {copied !== "idle" && <p role="status">{copied === "copied" ? "已复制本次诊断；后续状态变化可再次复制。" : "浏览器未允许复制，请选中下方内容手动复制。"}</p>}
    {copied === "manual" && <pre tabIndex={0} aria-label="可手动复制的诊断信息">{text}</pre>}
  </details>;
}

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
        <div className={`connection-path transport-${transport.mode}`}><span>当前设备</span><Icon className={transport.mode === "connecting" ? "spin" : ""} /><strong>家中服务器</strong></div>
        <dl className="connection-details">
          <div><dt>传输方式</dt><dd>{labels[transport.mode]}</dd></div>
          <div><dt>实时同步</dt><dd>{connection === "online" ? "正常" : connection === "connecting" ? "正在连接" : "连接中断，正在重试"}</dd></div>
          {transport.rttMs !== undefined && <div><dt>连接往返延迟</dt><dd>{Math.round(transport.rttMs)} ms</dd></div>}
        </dl>
        <p className="connection-explanation">{transport.mode === "direct" ? "文字、文件与预览可直接传到家中，绕过公网中转。网页、登录和连接协商仍使用 HTTPS。" : transport.mode === "relay" ? "直连暂不可用，当前通过 WebRTC 中继传输，速度受中继链路限制。" : transport.mode === "connecting" ? "正在尝试与家中节点打洞。在直连就绪前，使用现有 HTTPS 路径。" : "当前使用网站 HTTPS 路径。直连不可用时仍可发送和读取家中保存的内容。"}</p>
        {transport.detail && <p className="connection-detail">{transport.detail}</p>}
        <p className="connection-explanation">显示“已保存到家中”后，发送设备即可下线。另一台设备会独立建立自己的连接。大文件下载的浏览器兼容回退会单独提示。</p>
        <Button variant="outline" onClick={() => void retryTransport()} disabled={transport.mode === "connecting"}><RefreshCw size={16} />重新尝试直连</Button>
        <ConnectionLatency />
        {transport.diagnostics && <Diagnostics value={transport.diagnostics} />}
      </DialogContent>
    </Dialog>
  </>;
}
