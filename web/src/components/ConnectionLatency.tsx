import { useEffect, useRef, useState } from "react";
import { Activity, Gauge, LoaderCircle } from "lucide-react";
import { testConnectionLatency, type LatencyResult } from "@/lib/connection-test";
import { testConnectionSpeed, type SpeedResult, type SpeedProgress, type SpeedMeasurement } from "@/lib/speed-test";
import { Button } from "./ui/button";

const routes = { direct: "家中直连", relay: "WebRTC 中继", webrtc: "WebRTC（路径待确认）", https: "HTTPS" };

function SpeedValue({ title, value, error }: { title: string; value?: SpeedMeasurement; error?: string }) {
  return <div className="connection-speed-value">
    <b>{title}</b>
    {value ? <>
      <strong>{(value.bytesPerSecond / 1024 / 1024).toFixed(2)} MiB/s</strong>
      <span>{(value.bytesPerSecond * 8 / 1_000_000).toFixed(2)} Mbps · {(value.bytes / 1024 / 1024).toFixed(2)} MiB / {(value.durationMs / 1_000).toFixed(2)} 秒</span>
      <span>实测路径：{value.routes.map((route) => routes[route]).join("、")}</span>
    </> : <span className="inline-error">{error || "未完成"}</span>}
  </div>;
}

export function ConnectionLatency() {
  const pending = useRef<AbortController | null>(null);
  const [running, setRunning] = useState<"latency" | "speed" | null>(null);
  const [completed, setCompleted] = useState(0);
  const [result, setResult] = useState<LatencyResult | null>(null);
  const [error, setError] = useState("");
  const [speed, setSpeed] = useState<SpeedResult | null>(null);
  const [speedProgress, setSpeedProgress] = useState<SpeedProgress>({ direction: "download", bytes: 0 });
  useEffect(() => () => { pending.current?.abort(); pending.current = null; }, []);
  function cancel() {
    pending.current?.abort(); pending.current = null;
    setRunning(null);
  }
  async function run() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setRunning("latency"); setCompleted(0); setError(""); setResult(null); setSpeed(null);
    try {
      const measured = await testConnectionLatency(controller.signal, (count) => {
        if (pending.current === controller) setCompleted(count);
      });
      if (pending.current === controller) setResult(measured);
    } catch (reason) {
      if (!controller.signal.aborted && pending.current === controller) setError(reason instanceof Error ? reason.message : "测试失败，请重试。");
    } finally {
      if (pending.current === controller) { pending.current = null; setRunning(null); }
    }
  }
  async function runSpeed() {
    if (pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setRunning("speed"); setError(""); setResult(null); setSpeed(null);
    setSpeedProgress({ direction: "download", bytes: 0 });
    try {
      const measured = await testConnectionSpeed(controller.signal, (value) => {
        if (pending.current === controller) setSpeedProgress(value);
      });
      if (pending.current === controller) setSpeed(measured);
    } catch (reason) {
      if (!controller.signal.aborted && pending.current === controller) setError(reason instanceof Error ? reason.message : "测速失败，请重试。");
    } finally {
      if (pending.current === controller) { pending.current = null; setRunning(null); }
    }
  }
  return <section className="connection-latency" aria-label="连接测试">
    <div className="connection-test-actions">
      <Button variant="outline" disabled={!!running} onClick={() => void run()}>
        {running === "latency" ? <LoaderCircle size={16} className="spin" /> : <Activity size={16} />}
        {running === "latency" ? `正在测试 ${completed}/5` : "测试连接延迟"}
      </Button>
      <Button variant="outline" disabled={!!running} onClick={() => void runSpeed()}>
        {running === "speed" ? <LoaderCircle size={16} className="spin" /> : <Gauge size={16} />}
        测试传输速度
      </Button>
      {running && <Button variant="ghost" onClick={cancel}>取消测试</Button>}
    </div>
    <p className="connection-explanation">延迟测试发送 5 次小请求。测速会下载、上传随机测试数据，每方向上限 8 MiB，不保存到文件库。</p>
    {running === "speed" && <p role="status" className="connection-explanation">正在测试{speedProgress.direction === "download" ? "下载（家中 → 此设备）" : "上传（此设备 → 家中）"} · {(speedProgress.bytes / 1024 / 1024).toFixed(2)} MiB</p>}
    {result && <div className="connection-test-result" role="status">
      <strong>平均 {Math.round(result.averageMs)} ms</strong>
      <span>最低 {Math.round(result.minMs)} ms · 最高 {Math.round(result.maxMs)} ms · 成功 {result.samples.length}/5</span>
      <span>实测路径：{[...new Set(result.samples.map((sample) => routes[sample.route]))].join("、")}</span>
      <span>测试时间：{new Date(result.at).toLocaleTimeString()}</span>
      {result.failed > 0 && <span>失败 {result.failed} 次，延迟仅统计成功请求。</span>}
    </div>}
    {speed && <div className="connection-test-result" aria-label="传输速度测试结果" role="status">
      <SpeedValue title="下载 · 家中 → 此设备" value={speed.download} error={speed.downloadError} />
      <SpeedValue title="上传 · 此设备 → 家中" value={speed.upload} error={speed.uploadError} />
      <span>测试时间：{new Date(speed.at).toLocaleTimeString()}</span>
      <span>短时应用吞吐，包含请求与处理耗时；文件传输和网络波动会影响结果。</span>
    </div>}
    {error && <p className="inline-error" role="alert">{error}</p>}
  </section>;
}
