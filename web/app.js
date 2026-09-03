const loginView = document.querySelector("#login-view");
const appView = document.querySelector("#app-view");
const loginForm = document.querySelector("#login-form");
const loginError = document.querySelector("#login-error");
const textInput = document.querySelector("#text-input");
const sendTextButton = document.querySelector("#send-text");
const itemsElement = document.querySelector("#items");
const emptyState = document.querySelector("#empty-state");
const fileInput = document.querySelector("#file-input");
const dropZone = document.querySelector("#drop-zone");
const uploadList = document.querySelector("#upload-list");
const connectionStatus = document.querySelector("#connection-status");
const toast = document.querySelector("#toast");

let settings = { retentionHours: 24, maxFileBytes: 512 * 1024 * 1024 };
let eventSource;
let toastTimer;
let refreshTimer;
let reconnectTimer;
let sessionVersion = 0;
let authenticated = false;
let itemsRequest;
let connectionCheck;
const uploads = new Set();

function showToast(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setConnection(state) {
  connectionStatus.className = `status ${state}`;
  const message = state === "online" ? "家中节点在线" : state === "offline" ? "连接中断" : "正在连接";
  connectionStatus.querySelector("span").textContent = message;
  connectionStatus.setAttribute("aria-label", message);
  connectionStatus.title = message;
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers);
  if (options.method && options.method !== "GET" && options.method !== "HEAD") {
    headers.set("X-Clip-Request", "1");
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") || "";
  const payload = contentType.includes("application/json") ? await response.json() : null;
  if (!response.ok) {
    const error = new Error(payload?.error || `请求失败（${response.status}）`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function closeEvents() {
  if (eventSource) eventSource.close();
  eventSource = undefined;
}

function showLogin() {
  authenticated = false;
  sessionVersion += 1;
  closeEvents();
  clearTimeout(refreshTimer);
  clearTimeout(reconnectTimer);
  clearTimeout(toastTimer);
  toast.classList.remove("show");
  toast.textContent = "";
  for (const request of uploads) request.abort();
  itemsElement.replaceChildren();
  uploadList.replaceChildren();
  textInput.value = "";
  fileInput.value = "";
  emptyState.hidden = true;
  sendTextButton.disabled = false;
  appView.hidden = true;
  loginView.hidden = false;
  setTimeout(() => {
    if (!authenticated) document.querySelector("#username").focus();
  }, 0);
}

async function showApp(session) {
  authenticated = true;
  sessionVersion += 1;
  loginView.hidden = true;
  appView.hidden = false;
  settings = session.settings;
  document.querySelector("#retention-label").textContent =
    `自动保留 ${settings.retentionHours} 小时`;
  document.querySelector("#file-limit").textContent =
    `单个文件最大 ${formatSize(settings.maxFileBytes)}`;
  connectEvents();
  await loadItems();
}

function connectEvents() {
  if (!authenticated) return;
  closeEvents();
  clearTimeout(reconnectTimer);
  setConnection("connecting");
  const source = new EventSource("/api/events");
  eventSource = source;
  const isCurrent = () => authenticated && eventSource === source;
  source.addEventListener("ready", () => {
    if (!isCurrent()) return;
    setConnection("online");
    // A reconnect can miss changes while this device was offline.
    loadItems();
  });
  source.addEventListener("items", () => {
    if (!isCurrent()) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadItems, 120);
  });
  source.addEventListener("session-expired", () => {
    if (isCurrent()) showLogin();
  });
  source.onerror = () => {
    if (!isCurrent()) return;
    setConnection("offline");
    checkConnection();
  };
}

async function checkConnection() {
  if (!authenticated) return;
  const version = sessionVersion;
  if (connectionCheck === version) return;
  connectionCheck = version;
  try {
    const session = await api("/api/session");
    if (version !== sessionVersion) return;
    if (!session.authenticated) {
      showLogin();
      return;
    }
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) connectEvents();
    await loadItems();
  } catch (error) {
    if (version !== sessionVersion) return;
    if (error.status === 401) showLogin();
    else setConnection("offline");
  } finally {
    if (connectionCheck === version) connectionCheck = undefined;
    if (authenticated && version === sessionVersion &&
        (!eventSource || eventSource.readyState === EventSource.CLOSED)) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(checkConnection, 5000);
    }
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; value >= 1024 && index < units.length; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

function relativeTime(timestamp) {
  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat("zh-CN", { numeric: "auto" });
  if (Math.abs(seconds) < 60) return formatter.format(seconds, "second");
  const minutes = Math.round(seconds / 60);
  if (Math.abs(minutes) < 60) return formatter.format(minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return formatter.format(hours, "hour");
  return formatter.format(Math.round(hours / 24), "day");
}

function actionButton(label, className, handler) {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener("click", handler);
  return button;
}

async function copyText(text) {
  let copied = false;
  try {
    await navigator.clipboard.writeText(text);
    copied = true;
  } catch {
    const previousFocus = document.activeElement;
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    try {
      helper.select();
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      helper.remove();
      previousFocus?.focus({ preventScroll: true });
    }
  }
  showToast(copied ? "已经复制到剪贴板" : "复制失败，请允许剪贴板访问或手动选择文字复制", !copied);
}

async function deleteItem(item) {
  if (!authenticated) return;
  const version = sessionVersion;
  const label = item.kind === "file" ? item.fileName : "这段文字";
  if (!window.confirm(`删除“${label}”？`)) return;
  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    if (version !== sessionVersion) return;
    await loadItems();
    if (version === sessionVersion) showToast("已经删除");
  } catch (error) {
    if (version !== sessionVersion) return;
    if (error.status === 401) showLogin();
    else showToast(error.message, true);
  }
}

function renderItem(item) {
  const article = document.createElement("article");
  article.className = "item";

  const icon = document.createElement("div");
  icon.className = "item-icon";
  icon.textContent = item.kind === "text" ? "T" : "F";
  article.append(icon);

  const main = document.createElement("div");
  main.className = "item-main";
  const heading = document.createElement("div");
  heading.className = "item-heading";
  const title = document.createElement("strong");
  title.textContent = item.kind === "text" ? "文字剪贴板" : item.fileName;
  const time = document.createElement("time");
  time.dateTime = new Date(item.createdAt).toISOString();
  time.title = new Date(item.createdAt).toLocaleString("zh-CN");
  time.textContent = relativeTime(item.createdAt);
  heading.append(title, time);
  main.append(heading);

  if (item.kind === "text") {
    const content = document.createElement("p");
    content.className = "item-text";
    content.textContent = item.text;
    main.append(content);
  } else {
    const meta = document.createElement("p");
    meta.className = "item-meta";
    meta.textContent = `${formatSize(item.size)} · ${item.mimeType || "文件"} · ${relativeTime(item.expiresAt)}过期`;
    main.append(meta);
  }
  article.append(main);

  const actions = document.createElement("div");
  actions.className = "item-actions";
  if (item.kind === "text") {
    actions.append(actionButton("复制", "", () => copyText(item.text)));
  } else {
    const download = document.createElement("a");
    download.href = `/api/items/${item.id}/file`;
    download.textContent = "下载";
    download.setAttribute("download", item.fileName);
    actions.append(download);
  }
  actions.append(actionButton("删除", "delete", () => deleteItem(item)));
  article.append(actions);
  return article;
}

async function loadItems() {
  if (!authenticated) return;
  const version = sessionVersion;
  if (itemsRequest?.version === version) {
    itemsRequest.refreshAgain = true;
    return itemsRequest.promise;
  }
  const request = { version, refreshAgain: false };
  itemsRequest = request;
  request.promise = refreshItems(request);
  return request.promise;
}

async function refreshItems(request) {
  try {
    do {
      request.refreshAgain = false;
      const payload = await api("/api/items");
      if (request.version !== sessionVersion) return;
      itemsElement.replaceChildren(...payload.items.map(renderItem));
      emptyState.hidden = payload.items.length !== 0;
      if (eventSource?.readyState === EventSource.OPEN) setConnection("online");
    } while (request.refreshAgain);
  } catch (error) {
    if (request.version !== sessionVersion) return;
    if (error.status === 401) showLogin();
    else setConnection("offline");
  } finally {
    if (itemsRequest === request) itemsRequest = undefined;
  }
}

async function sendText() {
  if (!authenticated || sendTextButton.disabled) return;
  const version = sessionVersion;
  const text = textInput.value;
  if (!text) {
    textInput.focus();
    return;
  }
  if (settings.maxTextBytes && new TextEncoder().encode(text).length > settings.maxTextBytes) {
    showToast(`文字超过 ${formatSize(settings.maxTextBytes)} 限制`, true);
    return;
  }
  sendTextButton.disabled = true;
  try {
    await api("/api/items/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (version !== sessionVersion) return;
    if (textInput.value === text) textInput.value = "";
    await loadItems();
    if (version === sessionVersion) showToast("文字已发送");
  } catch (error) {
    if (version !== sessionVersion) return;
    if (error.status === 401) showLogin();
    else showToast(error.message, true);
  } finally {
    if (version === sessionVersion) sendTextButton.disabled = false;
  }
}

function uploadFile(file) {
  return new Promise((resolve, reject) => {
    if (file.size > settings.maxFileBytes) {
      reject(new Error(`${file.name} 超过 ${formatSize(settings.maxFileBytes)} 限制`));
      return;
    }
    if (file.size === 0) {
      reject(new Error(`${file.name} 是空文件`));
      return;
    }

    const wrapper = document.createElement("div");
    wrapper.className = "upload";
    const row = document.createElement("div");
    row.className = "upload-row";
    const name = document.createElement("span");
    name.textContent = file.name;
    const percent = document.createElement("span");
    percent.textContent = "准备上传";
    row.append(name, percent);
    const progress = document.createElement("div");
    progress.className = "progress";
    progress.setAttribute("role", "progressbar");
    progress.setAttribute("aria-label", `上传 ${file.name}`);
    progress.setAttribute("aria-valuemin", "0");
    progress.setAttribute("aria-valuemax", "100");
    const bar = document.createElement("i");
    progress.append(bar);
    wrapper.append(row, progress);
    uploadList.append(wrapper);

    const request = new XMLHttpRequest();
    uploads.add(request);
    const cleanup = () => {
      uploads.delete(request);
      wrapper.remove();
    };
    const fail = (message, name = "Error") => {
      cleanup();
      const error = new Error(message);
      error.name = name;
      reject(error);
    };
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const value = Math.round((event.loaded / event.total) * 100);
      bar.style.width = `${value}%`;
      percent.textContent = `${value}%`;
      progress.setAttribute("aria-valuenow", String(value));
    });
    request.addEventListener("load", () => {
      cleanup();
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        let message = "上传失败";
        try { message = JSON.parse(request.responseText).error || message; } catch {}
        const error = new Error(message);
        error.status = request.status;
        reject(error);
      }
    });
    request.addEventListener("error", () => fail("网络中断，文件上传失败"));
    request.addEventListener("timeout", () => fail("上传超时"));
    request.addEventListener("abort", () => fail("上传已取消", "AbortError"));
    try {
      request.open("POST", "/api/items/file");
      request.timeout = 60 * 60 * 1000;
      request.setRequestHeader("X-Clip-Request", "1");
      request.setRequestHeader("X-Clip-File-Name", encodeURIComponent(file.name));
      request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
      request.send(file);
    } catch (error) {
      fail(error.message);
    }
  });
}

async function uploadFiles(fileList) {
  if (!authenticated) return;
  const version = sessionVersion;
  const files = [...fileList];
  fileInput.value = "";
  if (!files.length) return;
  for (const file of files) {
    try {
      await uploadFile(file);
      if (version !== sessionVersion) return;
      showToast(`${file.name} 已发送`);
      await loadItems();
    } catch (error) {
      if (version !== sessionVersion || error.name === "AbortError") return;
      if (error.status === 401) {
        showLogin();
        return;
      }
      showToast(error.message, true);
    }
    if (version !== sessionVersion) return;
  }
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = loginForm.querySelector("button");
  if (button.disabled) return;
  loginError.textContent = "";
  button.disabled = true;
  try {
    await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value,
      }),
    });
    document.querySelector("#password").value = "";
    const fullSession = await api("/api/session");
    if (!fullSession.authenticated) throw new Error("登录状态未保存，请检查浏览器 Cookie 和 HTTPS 设置");
    await showApp(fullSession);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

sendTextButton.addEventListener("click", sendText);
textInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    sendText();
  }
});
document.querySelector("#pick-files").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", () => uploadFiles(fileInput.files));
for (const eventName of ["dragenter", "dragover"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.add("dragging");
  });
}
for (const eventName of ["dragleave", "drop"]) {
  dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    dropZone.classList.remove("dragging");
  });
}
dropZone.addEventListener("drop", (event) => uploadFiles(event.dataTransfer.files));
document.querySelector("#logout-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (button.disabled) return;
  const version = sessionVersion;
  button.disabled = true;
  try {
    await api("/api/auth/logout", { method: "POST" });
    if (version === sessionVersion) showLogin();
  } catch (error) {
    if (version !== sessionVersion) return;
    if (error.status === 401) showLogin();
    else showToast(`退出失败：${error.message}，请重试`, true);
  } finally {
    button.disabled = false;
  }
});

window.addEventListener("online", checkConnection);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") checkConnection();
});

async function boot() {
  try {
    const session = await api("/api/session");
    if (session.authenticated) await showApp(session);
    else showLogin();
  } catch {
    showLogin();
    showToast("暂时无法连接家中节点", true);
  }
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  }
}

boot();
