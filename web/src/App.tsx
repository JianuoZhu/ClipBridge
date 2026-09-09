import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle, ArrowDown, Check, Clipboard, Copy, FileArchive, FileText, FolderOpen,
  HardDrive, KeyRound, Library, Link2, LogIn, LogOut, Pencil, RefreshCw, Search, Send,
  ShieldCheck, Trash2, Upload, X
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { api, ApiError, formatSize, relativeTime } from "@/lib/client";
import type { ClipItem, LibraryFile, PreviewFile } from "@/lib/types";
import { useClipBridge } from "@/hooks/useClipBridge";
import { ThemePicker } from "@/components/ThemePicker";
import { Thumbnail } from "@/components/Thumbnail";
import { ConnectionStatus } from "@/components/ConnectionStatus";
import { DownloadButton } from "@/components/DownloadButton";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import "./app.css";

const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";
const PreviewDialog = lazy(() => import("@/components/PreviewDialog").then((module) => ({ default: module.PreviewDialog })));
const toPreview = (item: ClipItem | LibraryFile, scope: PreviewFile["scope"]): PreviewFile => ({
  scope, id: item.id, fileName: item.fileName || "文件", mimeType: item.mimeType, size: item.size,
  previewType: item.previewType || null,
  revision: "revision" in item ? item.revision : undefined,
  expiresAt: "expiresAt" in item ? item.expiresAt : undefined
});

function LoadingScreen() {
  return <main className="loading-screen"><img src="/icon.svg" alt="" /><span>正在连接你的设备…</span></main>;
}

function LoginScreen({ adminEnabled, login }: { adminEnabled: boolean; login: ReturnType<typeof useClipBridge>["login"] }) {
  const [pin, setPin] = useState("");
  const [adminOpen, setAdminOpen] = useState(false);
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (credentials: { pin: string } | { username: string; password: string }) => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      await login(credentials);
      setPin(""); setPassword(""); setAdminOpen(false);
    } catch (reason) { setError(messageOf(reason)); }
    finally { setBusy(false); }
  };
  return (
    <main className="login-screen">
      <div className="login-top"><div className="brand"><img src="/icon.svg" alt="" /><span>Jianuo Clip</span></div><ThemePicker /></div>
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-icon"><Link2 /></div>
        <h1 id="login-title">连接设备</h1>
        <p>输入访问 PIN，继续传输文字和文件。</p>
        <form onSubmit={(event) => { event.preventDefault(); void submit({ pin }); }}>
          <label>访问 PIN<input autoFocus type="password" inputMode="numeric" pattern="[0-9]{4,12}" minLength={4} maxLength={12}
            autoComplete="current-password" value={pin} onChange={(event) => setPin(event.target.value)} placeholder="4–12 位数字" required /></label>
          {error && !adminOpen && <p className="form-error" role="alert">{error}</p>}
          <Button type="submit" className="wide" disabled={busy}><LogIn size={17} />{busy ? "正在连接…" : "进入工作台"}</Button>
        </form>
        {adminEnabled && <Button type="button" variant="ghost" onClick={() => { setError(""); setAdminOpen(true); }}><ShieldCheck size={16} />管理员登录</Button>}
      </section>
      <p className="login-note"><KeyRound size={14} />内容只保存在你的 ClipBridge 服务中</p>
      <Dialog open={adminOpen} onOpenChange={setAdminOpen}>
        <DialogContent>
          <DialogHeader><DialogTitle>管理员登录</DialogTitle><DialogDescription>登录后可管理长期保存的文件库。</DialogDescription></DialogHeader>
          <form onSubmit={(event) => { event.preventDefault(); void submit({ username, password }); }} className="stack-form">
            <label>管理员账号<input autoComplete="username" value={username} onChange={(event) => setUsername(event.target.value)} required /></label>
            <label>密码<input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <Button type="submit" disabled={busy}>{busy ? "正在登录…" : "登录管理员"}</Button>
          </form>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function Uploads({ uploads, library, onCancel }: { uploads: ReturnType<typeof useClipBridge>["uploads"]; library: boolean; onCancel: (id: number) => void }) {
  const visible = uploads.filter((upload) => upload.library === library);
  if (!visible.length) return null;
  return <div className="upload-list" aria-live="polite">{visible.map((upload) => <div className="upload-row" key={upload.id}>
    <span>{upload.name}</span><strong>{upload.progress}%</strong><Button type="button" size="icon" variant="ghost" onClick={() => onCancel(upload.id)} aria-label={`取消上传 ${upload.name}`}><X size={14} /></Button><div><i style={{ width: upload.progress + "%" }} /></div>
  </div>)}</div>;
}

function Composer({ app }: { app: ReturnType<typeof useClipBridge> }) {
  const [text, setText] = useState("");
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const send = async () => {
    const current = text;
    if (await app.sendText(current)) setText((value) => value === current ? "" : value);
  };
  return <section className="compose-panel">
    <div className="panel-title"><div><h2>发送</h2><p>保存到家中后，可在其他设备接着使用</p></div><Send size={19} /></div>
    <div className="text-composer">
      <label className="sr-only" htmlFor="clip-text">发送文字</label>
      <textarea id="clip-text" value={text} onChange={(event) => setText(event.target.value)} placeholder="粘贴或输入文字…"
        onKeyDown={(event) => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); void send(); } }} />
      <div className="composer-actions"><span>Ctrl / ⌘ + Enter</span><Button onClick={() => void send()} disabled={!text || app.sending}><Send size={16} />{app.sending ? "发送中" : "发送"}</Button></div>
    </div>
    <div className={"drop-zone " + (dragging ? "dragging" : "")}
      onDragEnter={(event) => { event.preventDefault(); setDragging(true); }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDragging(false); }}
      onDrop={(event) => { event.preventDefault(); setDragging(false); void app.uploadFiles(event.dataTransfer.files); }}>
      <Upload size={21} /><div><strong>拖入文件</strong><span>或从设备中选择</span></div>
      <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>选择文件</Button>
      <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) void app.uploadFiles(event.target.files); event.target.value = ""; }} />
    </div>
    <p className="limit-note">单个文件最大 {formatSize(app.session?.settings.maxFileBytes || 0)}</p>
    <Uploads uploads={app.uploads} library={false} onCancel={app.cancelUpload} />
  </section>;
}

function TextCard({ item, app, compact = false }: { item: ClipItem; app: ReturnType<typeof useClipBridge>; compact?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const arriving = app.arriving.has("items:" + item.id);
  return <motion.article layout="position" initial={arriving ? { opacity: 0, y: -16, scale: .985 } : false}
    animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: .98 }}
    transition={{ type: "spring", stiffness: 410, damping: 34 }} className={"content-card text-card " + (arriving ? "is-new" : "")}>
    <div className="card-main">
      <div className="type-icon"><Clipboard size={18} /></div>
      <div className="content-body">
        <div className="card-meta"><span>文字</span><time dateTime={new Date(item.createdAt).toISOString()}>{relativeTime(item.createdAt)}</time>{arriving && <b>新</b>}</div>
        <button type="button" className={"text-preview " + (!expanded && !compact ? "clamped" : "")} onClick={() => setExpanded(!expanded)}>{item.text}</button>
      </div>
    </div>
    <div className="card-actions"><Button size="sm" variant="secondary" onClick={() => void app.copy(item.text || "")}><Copy size={15} />复制</Button>
      {!compact && <Button size="icon" variant="ghost" onClick={() => { if (confirm("删除这条文字？")) void app.deleteFile(item, false); }} aria-label="删除"><Trash2 size={16} /></Button>}</div>
  </motion.article>;
}

function FileCard({ item, app, scope, onPreview, onEdit, compact = false }: {
  item: ClipItem | LibraryFile; app: ReturnType<typeof useClipBridge>; scope: PreviewFile["scope"];
  onPreview: (file: PreviewFile) => void; onEdit?: (file: LibraryFile) => void; compact?: boolean;
}) {
  const preview = toPreview(item, scope);
  const arriving = app.arriving.has(scope + ":" + item.id);
  const canPreview = preview.previewType === "image" || preview.previewType === "pdf";
  return <motion.article layout="position" initial={arriving ? { opacity: 0, y: -16, scale: .985 } : false}
    animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: .98 }}
    transition={{ type: "spring", stiffness: 410, damping: 34 }} className={"content-card file-card " + (arriving ? "is-new" : "")}>
    <Thumbnail file={preview} sessionKey={app.sessionKey} onClick={canPreview ? () => onPreview(preview) : undefined} />
    <div className="content-body">
      <div className="card-meta"><span>{preview.previewType === "pdf" ? "PDF" : preview.previewType === "image" ? "图片" : "文件"}</span>
        <time>{relativeTime(item.createdAt)}</time>{arriving && <b>新</b>}</div>
      <strong className="file-name" title={preview.fileName}>{preview.fileName}</strong>
      <span className="file-size">{formatSize(item.size)}</span>
    </div>
    <div className="card-actions">
      {canPreview && <Button size="sm" variant="secondary" onClick={() => onPreview(preview)}>预览</Button>}
      <DownloadButton file={preview} onNotice={app.notify} />
      {onEdit && <Button size="icon" variant="ghost" onClick={() => onEdit(item as LibraryFile)} aria-label="编辑文件信息"><Pencil size={16} /></Button>}
      {!compact && <Button size="icon" variant="ghost" onClick={() => { if (confirm("删除“" + preview.fileName + "”？")) void app.deleteFile(item, scope === "library"); }} aria-label="删除"><Trash2 size={16} /></Button>}
    </div>
  </motion.article>;
}

function EmptyState({ library = false }: { library?: boolean }) {
  return <div className="empty-state">{library ? <FolderOpen /> : <Clipboard />}<strong>{library ? "还没有保存文件" : "等待第一条内容"}</strong>
    <span>{library ? "上传到这里的文件会一直保留" : "从左侧发送，或在另一台设备上打开 ClipBridge"}</span></div>;
}

function LibraryEditor({ file, app, onClose }: { file: LibraryFile | null; app: ReturnType<typeof useClipBridge>; onClose: () => void }) {
  const [name, setName] = useState("");
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [current, setCurrent] = useState<LibraryFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!file) return;
    setCurrent(file); setName(file.fileName); setText(""); setOriginal(""); setError("");
    if (file.previewType !== "text") return;
    const controller = new AbortController();
    setLoading(true);
    void api<{ file: LibraryFile; text: string }>("/api/library/" + file.id + "/content", { signal: controller.signal }).then((payload) => {
      setCurrent(payload.file); setName(payload.file.fileName); setText(payload.text); setOriginal(payload.text);
    }).catch((reason) => { if (reason.name !== "AbortError") setError(messageOf(reason)); }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [file]);
  const dirty = current && (name.trim() !== current.fileName || (current.previewType === "text" && text !== original));
  const close = () => { if (!dirty || confirm("放弃尚未保存的更改？")) onClose(); };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!current || saving) return;
    if (current.previewType === "text" && new TextEncoder().encode(text).length > (app.session?.settings.maxTextBytes || 0)) {
      setError("文本超过 " + formatSize(app.session?.settings.maxTextBytes || 0) + " 限制"); return;
    }
    setSaving(true); setError("");
    const body: { fileName: string; revision: number; text?: string } = { fileName: name.trim(), revision: current.revision };
    if (current.previewType === "text" && text !== original) body.text = text;
    try {
      await api("/api/library/" + current.id, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      await app.loadLibrary(); app.notify("文件已保存"); onClose();
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) app.signOut();
      else setError(messageOf(reason));
    } finally { setSaving(false); }
  };
  return <Dialog open={Boolean(file)} onOpenChange={(open) => { if (!open) close(); }}>
    <DialogContent className={current?.previewType === "text" ? "editor-dialog" : undefined}>
      <DialogHeader><DialogTitle>文件信息</DialogTitle><DialogDescription>修改文件名{current?.previewType === "text" ? "和 UTF-8 文本内容" : ""}。</DialogDescription></DialogHeader>
      <form onSubmit={(event) => void save(event)} className="stack-form">
        <label>文件名<input value={name} onChange={(event) => setName(event.target.value)} maxLength={240} required /></label>
        {current?.previewType === "text" && <label>文本内容<textarea className="text-editor" value={text} disabled={loading || saving} onChange={(event) => setText(event.target.value)} spellCheck={false} /></label>}
        {loading && <p className="muted-row"><RefreshCw className="spin" size={15} />正在读取文本…</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        <DialogFooter><Button type="button" variant="outline" onClick={close}>取消</Button><Button type="submit" disabled={loading || saving || !name.trim()}>{saving ? "正在保存…" : "保存更改"}</Button></DialogFooter>
      </form>
    </DialogContent>
  </Dialog>;
}

function ClipboardPanel({ app, onPreview }: { app: ReturnType<typeof useClipBridge>; onPreview: (file: PreviewFile) => void }) {
  return <div className="workspace">
    <aside><Composer app={app} /></aside>
    <div className="content-column">
      <section>
        <div className="section-heading"><div><h2>最新送达</h2><p>在另一台设备上接着使用</p></div><span>{app.latest.length ? app.latest.length + " 项" : ""}</span></div>
        <div className="latest-grid">
          {app.latest.map((item) => item.kind === "text"
            ? <TextCard key={"latest-" + item.id} item={item} app={app} compact />
            : <FileCard key={"latest-" + item.id} item={item} app={app} scope="items" compact onPreview={onPreview} />)}
        </div>
      </section>
      <section className="history-section" id="history">
        <div className="section-heading"><div><h2>传输记录</h2><p>自动保留 {app.session?.settings.retentionHours} 小时</p></div>
          <Button variant="ghost" size="icon" onClick={() => void app.loadItems()} aria-label="刷新"><RefreshCw size={16} /></Button></div>
        {app.itemsError && <div className="error-banner"><AlertCircle size={17} />{app.itemsError}<Button size="sm" variant="outline" onClick={() => void app.loadItems()}>重试</Button></div>}
        {app.itemsLoading && !app.items.length ? <div className="skeleton-list"><i /><i /><i /></div> :
          !app.items.length ? <EmptyState /> : <div className="items-list"><AnimatePresence initial={false}>
            {app.items.map((item) => item.kind === "text" ? <TextCard key={item.id} item={item} app={app} /> :
              <FileCard key={item.id} item={item} app={app} scope="items" onPreview={onPreview} />)}
          </AnimatePresence></div>}
      </section>
    </div>
  </div>;
}

function LibraryPanel({ app, onPreview, onEdit }: { app: ReturnType<typeof useClipBridge>; onPreview: (file: PreviewFile) => void; onEdit: (file: LibraryFile) => void }) {
  const [query, setQuery] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const files = useMemo(() => app.libraryFiles.filter((file) => file.fileName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), [app.libraryFiles, query]);
  return <section className="library-panel">
    <div className="library-toolbar">
      <div className="search-field"><Search size={17} /><label className="sr-only" htmlFor="library-search">搜索文件名</label>
        <input id="library-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名…" /></div>
      <span className="storage"><HardDrive size={15} />{formatSize(app.usedBytes)} / {formatSize(app.session?.settings.maxStorageBytes || 0)}</span>
      <Button onClick={() => fileInput.current?.click()}><Upload size={16} />上传文件</Button>
      <input ref={fileInput} type="file" multiple hidden onChange={(event) => { if (event.target.files) void app.uploadFiles(event.target.files, true); event.target.value = ""; }} />
    </div>
    <Uploads uploads={app.uploads} library onCancel={app.cancelUpload} />
    <div className="section-heading"><div><h2>文件库</h2><p>长期保存，仅管理员可访问</p></div><span>{files.length} 个文件</span></div>
    {app.libraryError && <div className="error-banner"><AlertCircle size={17} />{app.libraryError}<Button size="sm" variant="outline" onClick={() => void app.loadLibrary()}>重试</Button></div>}
    {app.libraryLoading && !files.length ? <div className="skeleton-list"><i /><i /><i /></div> :
      !files.length ? <EmptyState library /> : <div className="items-list"><AnimatePresence initial={false}>
        {files.map((file) => <FileCard key={file.id} item={file} app={app} scope="library" onPreview={onPreview} onEdit={onEdit} />)}
      </AnimatePresence></div>}
  </section>;
}

export default function App() {
  const app = useClipBridge();
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [editing, setEditing] = useState<LibraryFile | null>(null);
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminError, setAdminError] = useState("");
  const [username, setUsername] = useState("admin");
  const [password, setPassword] = useState("");
  const [update, setUpdate] = useState<ServiceWorkerRegistration | null>(null);
  useEffect(() => {
    const listener = (event: Event) => setUpdate((event as CustomEvent<ServiceWorkerRegistration>).detail);
    window.addEventListener("clipbridge-update", listener);
    return () => window.removeEventListener("clipbridge-update", listener);
  }, []);
  useEffect(() => { if (!app.session) { setPreview(null); setEditing(null); setAdminOpen(false); } }, [app.session]);
  if (app.booting) return <LoadingScreen />;
  if (!app.session?.authenticated) return <LoginScreen adminEnabled={app.adminEnabled} login={app.login} />;
  const adminLogin = async (event: React.FormEvent) => {
    event.preventDefault(); setAdminError("");
    try { await app.login({ username, password }); setPassword(""); setAdminOpen(false); }
    catch (reason) { setAdminError(messageOf(reason)); }
  };
  return <>
    <header className="app-header">
      <div className="header-inner">
        <div className="brand"><img src="/icon.svg" alt="" /><span>Jianuo Clip</span></div>
        <ConnectionStatus connection={app.connection} />
        <nav className="main-tabs" aria-label="工作空间">
          <button className={app.panel === "clipboard" ? "active" : ""} onClick={() => app.switchPanel("clipboard")}><Clipboard />设备传输</button>
          {app.session.role === "admin" && <button className={app.panel === "library" ? "active" : ""} onClick={() => app.switchPanel("library")}><Library />文件库</button>}
        </nav>
        <div className="header-actions"><ThemePicker />
          {app.session.role !== "admin" && app.adminEnabled && <Button variant="ghost" size="sm" onClick={() => setAdminOpen(true)}><ShieldCheck size={16} /><span>管理员</span></Button>}
          <Button variant="ghost" size="icon" onClick={() => void app.logout()} disabled={app.loggingOut} aria-label="退出登录" title="退出登录"><LogOut size={18} /></Button>
        </div>
      </div>
    </header>
    <main className="app-shell">
      {app.panel === "clipboard" ? <ClipboardPanel app={app} onPreview={setPreview} /> :
        <LibraryPanel app={app} onPreview={setPreview} onEdit={setEditing} />}
    </main>
    <AnimatePresence>
      {app.unread > 0 && <motion.button initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }}
        className="new-items-button" onClick={() => { app.clearUnread(); document.querySelector("#history")?.scrollIntoView({ behavior: "smooth" }); }}>
        <ArrowDown size={16} />有 {app.unread} 条新内容
      </motion.button>}
      {app.toast && <motion.div key={app.toast.id} role={app.toast.error ? "alert" : "status"} className={"toast " + (app.toast.error ? "error" : "")}
        initial={{ opacity: 0, y: 14, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0 }}>
        {app.toast.error ? <AlertCircle /> : <Check />}{app.toast.message}<button onClick={app.dismissToast} aria-label="关闭"><X /></button>
      </motion.div>}
    </AnimatePresence>
    {update && <div className="update-banner"><RefreshCw size={16} /><span>新版本已准备好</span><Button size="sm" onClick={() => { update.waiting?.postMessage("ACTIVATE_UPDATE"); window.location.reload(); }}>刷新使用</Button></div>}
    {preview && <Suspense fallback={null}><PreviewDialog file={preview} sessionKey={app.sessionKey} onClose={() => setPreview(null)} onUnauthorized={app.signOut} /></Suspense>}
    <LibraryEditor file={editing} app={app} onClose={() => setEditing(null)} />
    <Dialog open={adminOpen} onOpenChange={setAdminOpen}>
      <DialogContent><DialogHeader><DialogTitle>管理员登录</DialogTitle><DialogDescription>当前设备将切换为管理员会话。</DialogDescription></DialogHeader>
        <form onSubmit={(event) => void adminLogin(event)} className="stack-form"><label>账号<input value={username} onChange={(event) => setUsername(event.target.value)} /></label>
          <label>密码<input autoFocus type="password" value={password} onChange={(event) => setPassword(event.target.value)} required /></label>
          {adminError && <p className="form-error" role="alert">{adminError}</p>}<Button type="submit">登录管理员</Button></form>
      </DialogContent>
    </Dialog>
  </>;
}
