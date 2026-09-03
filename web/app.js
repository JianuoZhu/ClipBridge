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
let loadingItems = false;

function showToast(message, error = false) {
  toast.textContent = message;
  toast.classList.toggle("error", error);
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2600);
}

function setConnection(state) {
  connectionStatus.className = `status ${state}`;
  connectionStatus.querySelector("span").textContent =
    state === "online" ? "家中节点在线" : state === "offline" ? "连接中断" : "正在连接";
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
  closeEvents();
  appView.hidden = true;
  loginView.hidden = false;
  setTimeout(() => document.querySelector("#username").focus(), 0);
}

async function showApp(session) {
  loginView.hidden = true;
  appView.hidden = false;
  settings = session.settings;
  document.querySelector("#retention-label").textContent =
    `自动保留 ${settings.retentionHours} 小时`;
  document.querySelector("#file-limit").textContent =
    `单个文件最大 ${formatSize(settings.maxFileBytes)}`;
  await loadItems();
  connectEvents();
}

function connectEvents() {
  closeEvents();
  setConnection("connecting");
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("ready", () => setConnection("online"));
  eventSource.addEventListener("items", () => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadItems, 120);
  });
  eventSource.onerror = () => setConnection("offline");
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
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const helper = document.createElement("textarea");
    helper.value = text;
    helper.style.position = "fixed";
    helper.style.opacity = "0";
    document.body.append(helper);
    helper.select();
    document.execCommand("copy");
    helper.remove();
  }
  showToast("已经复制到剪贴板");
}

async function deleteItem(item) {
  const label = item.kind === "file" ? item.fileName : "这段文字";
  if (!window.confirm(`删除“${label}”？`)) return;
  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    await loadItems();
    showToast("已经删除");
  } catch (error) {
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
  if (loadingItems) return;
  loadingItems = true;
  try {
    const payload = await api("/api/items");
    itemsElement.replaceChildren(...payload.items.map(renderItem));
    emptyState.hidden = payload.items.length !== 0;
    setConnection("online");
  } catch (error) {
    if (error.status === 401) showLogin();
    else setConnection("offline");
  } finally {
    loadingItems = false;
  }
}

async function sendText() {
  const text = textInput.value;
  if (!text) {
    textInput.focus();
    return;
  }
  sendTextButton.disabled = true;
  try {
    await api("/api/items/text", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    textInput.value = "";
    await loadItems();
    showToast("文字已发送");
  } catch (error) {
    if (error.status === 401) showLogin();
    else showToast(error.message, true);
  } finally {
    sendTextButton.disabled = false;
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
    const bar = document.createElement("i");
    progress.append(bar);
    wrapper.append(row, progress);
    uploadList.append(wrapper);

    const request = new XMLHttpRequest();
    request.open("POST", "/api/items/file");
    request.timeout = 60 * 60 * 1000;
    request.setRequestHeader("X-Clip-Request", "1");
    request.setRequestHeader("X-Clip-File-Name", encodeURIComponent(file.name));
    request.setRequestHeader("Content-Type", file.type || "application/octet-stream");
    request.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const value = Math.round((event.loaded / event.total) * 100);
      bar.style.width = `${value}%`;
      percent.textContent = `${value}%`;
    });
    request.addEventListener("load", () => {
      wrapper.remove();
      if (request.status >= 200 && request.status < 300) resolve();
      else {
        let message = "上传失败";
        try { message = JSON.parse(request.responseText).error || message; } catch {}
        const error = new Error(message);
        error.status = request.status;
        reject(error);
      }
    });
    request.addEventListener("error", () => {
      wrapper.remove();
      reject(new Error("网络中断，文件上传失败"));
    });
    request.addEventListener("timeout", () => {
      wrapper.remove();
      reject(new Error("上传超时"));
    });
    request.send(file);
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  for (const file of files) {
    try {
      await uploadFile(file);
      showToast(`${file.name} 已发送`);
    } catch (error) {
      if (error.status === 401) {
        showLogin();
        return;
      }
      showToast(error.message, true);
    }
  }
  fileInput.value = "";
  await loadItems();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginError.textContent = "";
  const button = loginForm.querySelector("button");
  button.disabled = true;
  try {
    const session = await api("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: document.querySelector("#username").value,
        password: document.querySelector("#password").value,
      }),
    });
    document.querySelector("#password").value = "";
    const fullSession = await api("/api/session");
    await showApp(fullSession.authenticated ? fullSession : session);
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
document.querySelector("#logout-button").addEventListener("click", async () => {
  try { await api("/api/auth/logout", { method: "POST" }); } catch {}
  showLogin();
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
