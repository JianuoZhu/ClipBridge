import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError, copyText, formatSize, uploadFile } from "../lib/client";
import { clearPreviewCache } from "../lib/thumbnails";
import { createEventStream, type EventStream } from "../lib/event-stream";
import { getTransportSnapshot, startTransport, stopTransport, subscribeTransport } from "../lib/transport";
import type { ClipItem, LibraryFile } from "../lib/types";

export interface Settings {
  retentionHours: number;
  maxFileBytes: number;
  maxTextBytes: number;
  maxStorageBytes: number;
}
export interface Session {
  authenticated: boolean;
  role?: "member" | "admin";
  username?: string;
  adminEnabled?: boolean;
  settings: Settings;
}
export interface UploadProgress { id: number; name: string; progress: number; library: boolean }
interface RefreshRequest { generation: number; again: boolean; promise: Promise<void> }
export type Toast = { id: number; message: string; error: boolean } | null;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "操作失败，请重试";

export function useClipBridge() {
  const [session, setSession] = useState<Session | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const [booting, setBooting] = useState(true);
  const [adminEnabled, setAdminEnabled] = useState(true);
  const [items, setItems] = useState<ClipItem[]>([]);
  const [latest, setLatest] = useState<ClipItem[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [itemsError, setItemsError] = useState("");
  const [libraryFiles, setLibraryFiles] = useState<LibraryFile[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const [libraryError, setLibraryError] = useState("");
  const [usedBytes, setUsedBytes] = useState(0);
  const [panel, setPanelState] = useState<"clipboard" | "library">("clipboard");
  const [connection, setConnection] = useState<"connecting" | "online" | "offline">("connecting");
  const [sending, setSending] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [uploads, setUploads] = useState<UploadProgress[]>([]);
  const [toast, setToast] = useState<Toast>(null);
  const [arriving, setArriving] = useState<Set<string>>(new Set());
  const [unread, setUnread] = useState(0);
  const [streamEpoch, setStreamEpoch] = useState(0);
  const generation = useRef(0);
  const sessionRef = useRef<Session | null>(null);
  const panelRef = useRef<"clipboard" | "library">("clipboard");
  const streamRef = useRef<EventStream | null>(null);
  const itemsRevision = useRef(0);
  const itemsRequest = useRef<RefreshRequest | null>(null);
  const libraryRequest = useRef<RefreshRequest | null>(null);
  const hydrated = useRef({ items: false, library: false });
  const seen = useRef({ items: new Set<string>(), library: new Set<string>() });
  const eventKeys = useRef(new Set<string>());
  const arrivalTimers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const uploadControllers = useRef(new Map<number, AbortController>());
  const uploadingQueue = useRef<Promise<void>>(Promise.resolve());
  const uploadCounter = useRef(0);
  const sendBusy = useRef(false);
  const logoutBusy = useRef(false);
  const authBusy = useRef(false);
  const toastCounter = useRef(0);
  const lifecycle = useRef(0);
  const notify = useCallback((message: string, error = false) => setToast({ id: ++toastCounter.current, message, error }), []);

  const clearPrivateData = useCallback(() => {
    generation.current += 1;
    stopTransport();
    itemsRevision.current += 1;
    streamRef.current?.close();
    streamRef.current = null;
    for (const controller of uploadControllers.current.values()) controller.abort();
    uploadControllers.current.clear();
    uploadingQueue.current = Promise.resolve();
    for (const timer of arrivalTimers.current) clearTimeout(timer);
    arrivalTimers.current.clear();
    clearPreviewCache();
    hydrated.current = { items: false, library: false };
    seen.current = { items: new Set(), library: new Set() };
    eventKeys.current.clear();
    sendBusy.current = false;
    setItems([]); setLatest([]); setLibraryFiles([]); setUsedBytes(0);
    setItemsError(""); setLibraryError(""); setUploads([]); setArriving(new Set()); setUnread(0);
    setItemsLoading(false); setLibraryLoading(false); setSending(false); setToast(null);
    setSessionKey(generation.current);
  }, []);

  const signOut = useCallback(() => {
    clearPrivateData();
    sessionRef.current = null;
    setSession(null);
    panelRef.current = "clipboard";
    setPanelState("clipboard");
  }, [clearPrivateData]);

  const enterSession = useCallback((value: Session, openLibrary = false) => {
    clearPrivateData();
    sessionRef.current = value;
    setSession(value);
    void startTransport();
    setAdminEnabled(value.adminEnabled !== false);
    const next = openLibrary && value.role === "admin" ? "library" : "clipboard";
    panelRef.current = next;
    setPanelState(next);
  }, [clearPrivateData]);

  const detectArrivals = useCallback((scope: "items" | "library", values: Array<{ id: string }>) => {
    const previous = seen.current[scope];
    const fresh = hydrated.current[scope] ? values.filter((value) => !previous.has(value.id)) : [];
    for (const value of values) previous.add(value.id);
    hydrated.current[scope] = true;
    if (!fresh.length) return;
    const keys = [...new Set(fresh.map((value) => `${scope}:${value.id}`))];
    setArriving((current) => new Set([...current, ...keys]));
    if (scope === "items" && (window.scrollY > 180 || panelRef.current !== "clipboard")) setUnread((count) => count + keys.length);
    const timer = setTimeout(() => {
      setArriving((current) => new Set([...current].filter((key) => !keys.includes(key))));
      arrivalTimers.current.delete(timer);
    }, 1500);
    arrivalTimers.current.add(timer);
  }, []);

  const loadItems = useCallback((): Promise<void> => {
    if (!sessionRef.current?.authenticated) return Promise.resolve();
    const version = generation.current;
    if (itemsRequest.current?.generation === version) {
      itemsRequest.current.again = true;
      return itemsRequest.current.promise;
    }
    const request: RefreshRequest = { generation: version, again: false, promise: Promise.resolve() };
    itemsRequest.current = request;
    if (!hydrated.current.items) setItemsLoading(true);
    request.promise = (async () => {
      try {
        do {
          request.again = false;
          const revision = itemsRevision.current;
          const payload = await api<{ items: ClipItem[]; latest?: ClipItem[] }>("/api/items");
          if (version !== generation.current) return;
          // A POST may complete while an older list snapshot is in flight.
          if (revision !== itemsRevision.current) { request.again = true; continue; }
          const newest = payload.latest || ["text", "file"].map((kind) => payload.items.find((item) => item.kind === kind)).filter((item): item is ClipItem => Boolean(item));
          detectArrivals("items", [...new Map([...payload.items, ...newest].map((item) => [item.id, item])).values()]);
          setItems(payload.items); setLatest(newest); setItemsError("");
          if (streamRef.current?.readyState === 1) setConnection("online");
        } while (request.again);
      } catch (error) {
        if (version !== generation.current) return;
        if (error instanceof ApiError && error.status === 401) signOut();
        else { setConnection("offline"); setItemsError(messageOf(error)); }
      } finally {
        if (itemsRequest.current === request) itemsRequest.current = null;
        if (version === generation.current) setItemsLoading(false);
      }
    })();
    return request.promise;
  }, [detectArrivals, signOut]);

  const loadLibrary = useCallback((): Promise<void> => {
    if (!sessionRef.current?.authenticated || sessionRef.current.role !== "admin") return Promise.resolve();
    const version = generation.current;
    if (libraryRequest.current?.generation === version) {
      libraryRequest.current.again = true;
      return libraryRequest.current.promise;
    }
    const request: RefreshRequest = { generation: version, again: false, promise: Promise.resolve() };
    libraryRequest.current = request;
    if (!hydrated.current.library) setLibraryLoading(true);
    request.promise = (async () => {
      try {
        do {
          request.again = false;
          const payload = await api<{ files: LibraryFile[]; usedBytes: number }>("/api/library");
          if (version !== generation.current) return;
          detectArrivals("library", payload.files);
          setLibraryFiles(payload.files); setUsedBytes(payload.usedBytes); setLibraryError("");
        } while (request.again);
      } catch (error) {
        if (version !== generation.current) return;
        if (error instanceof ApiError && error.status === 401) signOut();
        else setLibraryError(messageOf(error));
      } finally {
        if (libraryRequest.current === request) libraryRequest.current = null;
        if (version === generation.current) setLibraryLoading(false);
      }
    })();
    return request.promise;
  }, [detectArrivals, signOut]);

  useEffect(() => {
    const run = ++lifecycle.current;
    void api<Session>("/api/session").then((value) => {
      if (lifecycle.current !== run) return;
      setAdminEnabled(value.adminEnabled !== false);
      if (value.authenticated) enterSession(value);
      else signOut();
    }).catch(() => {
      if (lifecycle.current === run) { signOut(); notify("暂时无法连接家中节点", true); }
    }).finally(() => { if (lifecycle.current === run) setBooting(false); });
    return () => {
      lifecycle.current += 1;
      generation.current += 1;
      stopTransport();
      streamRef.current?.close();
      for (const controller of uploadControllers.current.values()) controller.abort();
      for (const timer of arrivalTimers.current) clearTimeout(timer);
      clearPreviewCache();
    };
  }, [enterSession, notify, signOut]);

  useEffect(() => {
    if (!session?.authenticated) return;
    const version = generation.current;
    let disposed = false;
    let checking = false;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    const current = () => !disposed && version === generation.current;
    const connect = () => {
      if (!current()) return;
      streamRef.current?.close();
      setConnection("connecting");
      const source = createEventStream("/api/events");
      streamRef.current = source;
      const isSource = () => current() && streamRef.current === source;
      source.addEventListener("ready", () => {
        if (!isSource()) return;
        setConnection("online"); void loadItems();
        if (panelRef.current === "library") void loadLibrary();
      });
      source.addEventListener("items", (message) => {
        if (!isSource()) return;
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as { action?: string; itemId?: string };
          if (event.itemId) {
            const key = `${event.action || "changed"}:${event.itemId}`;
            if (eventKeys.current.has(key)) return;
            eventKeys.current.add(key);
            if (eventKeys.current.size > 256) eventKeys.current.delete(eventKeys.current.values().next().value!);
          }
        } catch { /* A reconnecting or older server can still trigger a list diff. */ }
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void loadItems(), 30);
      });
      source.addEventListener("library", () => { if (isSource() && panelRef.current === "library") void loadLibrary(); });
      source.addEventListener("session-expired", () => { if (isSource()) signOut(); });
      source.onerror = () => { if (isSource()) { setConnection("offline"); void check(); } };
    };
    const check = async () => {
      if (!current() || checking) return;
      checking = true;
      try {
        const value = await api<Session>("/api/session");
        if (!current()) return;
        if (!value.authenticated) { signOut(); return; }
        if (value.role !== sessionRef.current?.role) { enterSession(value); return; }
        if (!streamRef.current || streamRef.current.readyState === 2) connect();
        await loadItems();
        if (panelRef.current === "library") await loadLibrary();
      } catch (error) {
        if (!current()) return;
        if (error instanceof ApiError && error.status === 401) signOut();
        else setConnection("offline");
      } finally {
        checking = false;
        if (current() && (!streamRef.current || streamRef.current.readyState === 2)) {
          clearTimeout(reconnectTimer);
          reconnectTimer = setTimeout(() => void check(), 5000);
        }
      }
    };
    const visible = () => { if (document.visibilityState === "visible") void check(); };
    const online = () => void check();
    const direct = () => ["direct", "relay"].includes(getTransportSnapshot().mode);
    let wasDirect = direct();
    const unsubscribeTransport = subscribeTransport(() => {
      const isDirect = direct();
      if (wasDirect === isDirect || !current()) return;
      wasDirect = isDirect;
      connect();
    });
    connect(); void loadItems();
    if (panelRef.current === "library") void loadLibrary();
    window.addEventListener("online", online);
    document.addEventListener("visibilitychange", visible);
    return () => {
      disposed = true; clearTimeout(refreshTimer); clearTimeout(reconnectTimer);
      unsubscribeTransport();
      streamRef.current?.close(); streamRef.current = null;
      window.removeEventListener("online", online); document.removeEventListener("visibilitychange", visible);
    };
  }, [session?.authenticated, sessionKey, streamEpoch, enterSession, loadItems, loadLibrary, signOut]);

  const login = useCallback(async (credentials: { pin: string } | { username: string; password: string }) => {
    if (authBusy.current) return;
    authBusy.current = true;
    const version = generation.current;
    const admin = "username" in credentials;
    if (admin) { streamRef.current?.close(); streamRef.current = null; }
    try {
      await api(admin ? "/api/auth/admin" : "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(credentials) });
      const value = await api<Session>("/api/session");
      if (version !== generation.current) return;
      if (!value.authenticated || (admin && value.role !== "admin")) throw new Error("登录状态未保存，请检查浏览器 Cookie 和 HTTPS 设置");
      enterSession(value, admin);
    } catch (error) {
      if (version === generation.current) {
        if (admin && sessionRef.current?.authenticated) setStreamEpoch((epoch) => epoch + 1);
        throw error;
      }
    } finally { authBusy.current = false; }
  }, [enterSession]);

  const logout = useCallback(async () => {
    if (logoutBusy.current || !sessionRef.current) return;
    logoutBusy.current = true; setLoggingOut(true);
    const version = generation.current;
    try { await api("/api/auth/logout", { method: "POST" }); if (version === generation.current) signOut(); }
    catch (error) {
      if (version !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) signOut();
      else notify(`退出失败：${messageOf(error)}，请重试`, true);
    } finally { logoutBusy.current = false; setLoggingOut(false); }
  }, [notify, signOut]);

  const sendText = useCallback(async (text: string): Promise<boolean> => {
    const active = sessionRef.current;
    if (!active?.authenticated || sendBusy.current || !text) return false;
    if (active.settings.maxTextBytes && new TextEncoder().encode(text).length > active.settings.maxTextBytes) {
      notify(`文字超过 ${formatSize(active.settings.maxTextBytes)} 限制`, true); return false;
    }
    const version = generation.current;
    sendBusy.current = true; setSending(true);
    try {
      const { item } = await api<{ item: ClipItem }>("/api/items/text", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
      if (version !== generation.current) return false;
      itemsRevision.current += 1;
      seen.current.items.add(item.id);
      setItems((current) => [item, ...current.filter((value) => value.id !== item.id)].slice(0, 100));
      setLatest((current) => [item, ...current.filter((value) => value.kind !== "text")]);
      setItemsError("");
      void loadItems();
      notify("文字已保存到家中"); return true;
    } catch (error) {
      if (version === generation.current) {
        if (error instanceof ApiError && error.status === 401) signOut(); else notify(messageOf(error), true);
      }
      return false;
    } finally { if (version === generation.current) { sendBusy.current = false; setSending(false); } }
  }, [loadItems, notify, signOut]);

  const uploadFiles = useCallback((fileList: FileList | File[], library = false): Promise<void> => {
    const active = sessionRef.current;
    if (!active?.authenticated || (library && active.role !== "admin")) return Promise.resolve();
    const version = generation.current;
    const files = Array.from(fileList);
    const run = async () => {
      for (const file of files) {
        if (version !== generation.current) return;
        if (file.size > active.settings.maxFileBytes || file.size === 0) {
          notify(file.size === 0 ? `${file.name} 是空文件` : `${file.name} 超过 ${formatSize(active.settings.maxFileBytes)} 限制`, true); continue;
        }
        const id = ++uploadCounter.current;
        const controller = new AbortController();
        uploadControllers.current.set(id, controller);
        setUploads((values) => [...values, { id, name: file.name, progress: 0, library }]);
        try {
          await uploadFile(file, library, controller.signal, (progress) => {
            if (version === generation.current) setUploads((values) => values.map((value) => value.id === id ? { ...value, progress } : value));
          });
          if (version !== generation.current) return;
          notify(`${file.name} ${library ? "已存入文件库" : "已保存到家中"}`);
          if (library) await loadLibrary(); else await loadItems();
        } catch (error) {
          if (version !== generation.current || (error instanceof Error && error.name === "AbortError")) return;
          if (error instanceof ApiError && error.status === 401) { signOut(); return; }
          notify(messageOf(error), true);
        } finally {
          uploadControllers.current.delete(id);
          if (version === generation.current) setUploads((values) => values.filter((value) => value.id !== id));
        }
      }
    };
    const queued = uploadingQueue.current.then(run, run);
    uploadingQueue.current = queued;
    return queued;
  }, [loadItems, loadLibrary, notify, signOut]);

  const cancelUpload = useCallback((id: number) => {
    const controller = uploadControllers.current.get(id);
    if (!controller) return;
    controller.abort();
    uploadControllers.current.delete(id);
    setUploads((values) => values.filter((value) => value.id !== id));
    notify("上传已取消");
  }, [notify]);

  const deleteFile = useCallback(async (item: ClipItem | LibraryFile, library: boolean) => {
    if (!sessionRef.current?.authenticated || (library && sessionRef.current.role !== "admin")) return;
    const version = generation.current;
    try {
      await api(`/api/${library ? "library" : "items"}/${item.id}`, {
        method: "DELETE", ...(library ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: (item as LibraryFile).revision }) } : {}),
      });
      if (version !== generation.current) return;
      clearPreviewCache();
      if (library) await loadLibrary(); else await loadItems();
      if (version === generation.current) notify("已经删除");
    } catch (error) {
      if (version !== generation.current) return;
      if (error instanceof ApiError && error.status === 401) signOut();
      else {
        notify(messageOf(error), true);
        if (library && error instanceof ApiError && [404, 409].includes(error.status)) void loadLibrary();
      }
    }
  }, [loadItems, loadLibrary, notify, signOut]);

  const copy = useCallback(async (text: string) => {
    const version = generation.current;
    const copied = await copyText(text);
    if (version === generation.current) notify(copied ? "已经复制到剪贴板" : "复制失败，请允许剪贴板访问或手动选择文字复制", !copied);
  }, [notify]);
  const switchPanel = useCallback((value: "clipboard" | "library") => {
    if (value === "library" && sessionRef.current?.role !== "admin") return;
    panelRef.current = value; setPanelState(value);
    if (value === "library") void loadLibrary();
  }, [loadLibrary]);

  return {
    session, sessionKey, booting, adminEnabled, items, latest, itemsLoading, itemsError,
    libraryFiles, libraryLoading, libraryError, usedBytes, panel, connection, sending,
    loggingOut, uploads, toast, arriving, unread,
    notify, dismissToast: () => setToast(null), clearUnread: () => setUnread(0),
    login, logout, signOut, sendText, uploadFiles, cancelUpload, deleteFile, copy, switchPanel, loadItems, loadLibrary,
  };
}
