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
const latestItemsElement = document.querySelector("#latest-items");
const libraryPanel = document.querySelector("#library-panel");
const libraryFilesElement = document.querySelector("#library-files");
const libraryInput = document.querySelector("#library-input");
const libraryUploads = document.querySelector("#library-uploads");
const adminDialog = document.querySelector("#admin-dialog");
const fileDialog = document.querySelector("#file-dialog");
const fileEditor = document.querySelector("#file-editor");
let role = "member";
let libraryFiles = [];
let libraryRequest;
let editorVersion = 0;
let editingFile;
let editorOriginalText;
let editorCanEdit = false;
let editorBusy = false;

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
  latestItemsElement.replaceChildren();
  libraryFilesElement.replaceChildren();
  libraryFiles = [];
  libraryUploads.replaceChildren();
  libraryInput.value = "";
  document.querySelector("#library-search").value = "";
  document.querySelector("#library-storage").textContent = "";
  document.querySelector("#library-error").textContent = "";
  clearEditor();
  adminDialog.close();
  document.querySelector("#password").value = "";
  document.querySelector("#pin").value = "";
  role = "member";
  uploadList.replaceChildren();
  textInput.value = "";
  fileInput.value = "";
  emptyState.hidden = true;
  sendTextButton.disabled = false;
  appView.hidden = true;
  loginView.hidden = false;
  setTimeout(() => {
    if (!authenticated) document.querySelector("#pin").focus();
  }, 0);
}

async function showApp(session) {
  authenticated = true;
  sessionVersion += 1;
  loginView.hidden = true;
  appView.hidden = false;
  settings = session.settings;
  role = session.role || "member";
  document.querySelector("#library-tab").hidden = role !== "admin";
  document.querySelector("#admin-button").hidden = role === "admin" || session.adminEnabled === false;
  switchPanel("clipboard");
  document.querySelector("#retention-label").textContent =
    `自动保留 ${settings.retentionHours} 小时`;
  document.querySelector("#file-limit").textContent =
    `单个文件最大 ${formatSize(settings.maxFileBytes)}`;
  connectEvents();
  await loadItems();
}

function switchPanel(panel) {
  const library = panel === "library" && role === "admin";
  document.querySelector("#clipboard-panel").hidden = library;
  libraryPanel.hidden = !library;
  for (const [id, active] of [["#clipboard-tab", !library], ["#library-tab", library]]) {
    document.querySelector(id).classList.toggle("active", active);
    document.querySelector(id).setAttribute("aria-pressed", String(active));
  }
  if (library) loadLibrary();
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
    if (!libraryPanel.hidden) loadLibrary();
  });
  source.addEventListener("items", () => {
    if (!isCurrent()) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(loadItems, 120);
  });
  source.addEventListener("session-expired", () => {
    if (isCurrent()) showLogin();
  });
  source.addEventListener("library", () => {
    if (isCurrent() && role === "admin" && !libraryPanel.hidden) loadLibrary();
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
    if (!libraryPanel.hidden) await loadLibrary();
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

function renderItem(item, featured = false) {
  const article = document.createElement("article");
  article.className = featured ? "item featured-item" : "item";

  const icon = document.createElement("div");
  icon.className = "item-icon";
  icon.textContent = item.kind === "text" ? "T" : "F";
  article.append(icon);

  const main = document.createElement("div");
  main.className = "item-main";
  const heading = document.createElement("div");
  heading.className = "item-heading";
  const title = document.createElement("strong");
  title.textContent = item.kind === "text" ? (featured ? "最新文字" : "文字剪贴板") : item.fileName;
  if (featured) {
    const badge = document.createElement("span");
    badge.className = "latest-badge";
    badge.textContent = item.kind === "text" ? "TEXT · 最新" : "FILE · 最新";
    main.append(badge);
  }
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
      itemsElement.replaceChildren(...payload.items.map((item) => renderItem(item)));
      const latest = payload.latest || ["text", "file"].map((kind) => payload.items.find((item) => item.kind === kind)).filter(Boolean);
      latestItemsElement.replaceChildren(...["text", "file"].map((kind) => {
        const item = latest.find((entry) => entry.kind === kind);
        if (item) return renderItem(item, true);
        const placeholder = document.createElement("div");
        placeholder.className = "latest-placeholder";
        const title = document.createElement("strong");
        title.textContent = kind === "text" ? "最新文字" : "最新文件";
        const copy = document.createElement("p");
        copy.textContent = kind === "text" ? "发送第一段文字，即可在这里复制。" : "发送一个文件，即可在这里下载。";
        placeholder.append(title, copy);
        return placeholder;
      }));
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

function uploadFile(file, library = false) {
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
    (library ? libraryUploads : uploadList).append(wrapper);

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
      request.open("POST", library ? "/api/library" : "/api/items/file");
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

async function uploadFiles(fileList, library = false) {
  if (!authenticated || (library && role !== "admin")) return;
  const version = sessionVersion;
  const files = [...fileList];
  (library ? libraryInput : fileInput).value = "";
  if (!files.length) return;
  for (const file of files) {
    try {
      await uploadFile(file, library);
      if (version !== sessionVersion) return;
      showToast(`${file.name} ${library ? "已存入文件库" : "已发送"}`);
      if (library) await loadLibrary();
      else await loadItems();
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
        pin: document.querySelector("#pin").value,
      }),
    });
    document.querySelector("#pin").value = "";
    const fullSession = await api("/api/session");
    if (!fullSession.authenticated) throw new Error("登录状态未保存，请检查浏览器 Cookie 和 HTTPS 设置");
    await showApp(fullSession);
  } catch (error) {
    loginError.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

async function loadLibrary() {
  if (!authenticated || role !== "admin") return;
  const version = sessionVersion;
  if (libraryRequest?.version === version) {
    libraryRequest.again = true;
    return libraryRequest.promise;
  }
  const request = { version, again: false };
  libraryRequest = request;
  request.promise = (async () => {
    try {
      do {
        request.again = false;
        const payload = await api("/api/library");
        if (version !== sessionVersion) return;
        libraryFiles = payload.files;
        document.querySelector("#library-storage").textContent = `总存储 ${formatSize(payload.usedBytes)} / ${formatSize(settings.maxStorageBytes)}`;
        document.querySelector("#library-error").textContent = "";
        renderLibrary();
      } while (request.again);
    } catch (error) {
      if (version !== sessionVersion) return;
      if (error.status === 401) showLogin();
      else document.querySelector("#library-error").textContent = `${error.message}。重新点击文件库可重试。`;
    } finally {
      if (libraryRequest === request) libraryRequest = undefined;
    }
  })();
  return request.promise;
}

function renderLibrary() {
  const query = document.querySelector("#library-search").value.trim().toLocaleLowerCase();
  const files = libraryFiles.filter((file) => file.fileName.toLocaleLowerCase().includes(query));
  document.querySelector("#library-count").textContent = `${files.length} 个文件`;
  const empty = document.querySelector("#library-empty");
  empty.hidden = files.length !== 0;
  empty.querySelector("h3").textContent = query ? "没有匹配的文件" : "留一份重要文件";
  empty.querySelector("p").textContent = query ? "试试其他文件名。" : "上传到这里的文件会一直保留，直到你手动删除。";
  libraryFilesElement.replaceChildren(...files.map((file) => {
    const article = document.createElement("article");
    article.className = "item library-item";
    const icon = document.createElement("div");
    icon.className = "item-icon";
    icon.textContent = file.previewType === "image" ? "IMG" : file.previewType === "text" ? "TXT" : "FILE";
    const main = document.createElement("div");
    main.className = "item-main";
    const heading = document.createElement("div");
    heading.className = "item-heading";
    const title = document.createElement("strong");
    title.textContent = file.fileName;
    title.title = file.fileName;
    heading.append(title);
    const meta = document.createElement("p");
    meta.className = "item-meta";
    meta.textContent = `${formatSize(file.size)} · ${relativeTime(file.updatedAt)}更新 · 长期保存`;
    main.append(heading, meta);
    const actions = document.createElement("div");
    actions.className = "item-actions";
    actions.append(actionButton(file.previewType ? "预览 / 编辑" : "管理", "", () => openFile(file)));
    const download = document.createElement("a");
    download.href = `/api/library/${file.id}/file`;
    download.setAttribute("download", file.fileName);
    download.textContent = "下载";
    actions.append(download, actionButton("删除", "delete", () => deleteLibraryFile(file)));
    article.append(icon, main, actions);
    return article;
  }));
}

async function deleteLibraryFile(file) {
  if (!authenticated || role !== "admin" || !window.confirm(`永久删除“${file.fileName}”？`)) return;
  const version = sessionVersion;
  try {
    await api(`/api/library/${file.id}`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ revision: file.revision }) });
    if (version !== sessionVersion) return;
    await loadLibrary();
    if (version === sessionVersion) showToast("文件已删除");
  } catch (error) {
    if (version !== sessionVersion) return;
    if (error.status === 401) showLogin();
    else {
      showToast(error.message, true);
      if (error.status === 409 || error.status === 404) loadLibrary();
    }
  }
}

function clearEditor() {
  editorVersion += 1;
  editingFile = undefined;
  editorOriginalText = undefined;
  editorCanEdit = false;
  editorBusy = false;
  fileEditor.value = "";
  document.querySelector("#edit-file-name").value = "";
  document.querySelector("#image-preview").replaceChildren();
  document.querySelector("#file-download").removeAttribute("href");
  document.querySelector("#text-editor-label").hidden = true;
  document.querySelector("#file-error").textContent = "";
  document.querySelector("#preview-message").textContent = "";
  fileDialog.close();
}

function closeEditor() {
  if (editorBusy) return;
  const dirty = editingFile && (document.querySelector("#edit-file-name").value !== editingFile.fileName ||
    (editorCanEdit && fileEditor.value !== editorOriginalText));
  if (dirty && !window.confirm("放弃尚未保存的更改？")) return;
  clearEditor();
}

async function openFile(file) {
  if (!authenticated || role !== "admin") return;
  clearEditor();
  editingFile = file;
  const version = sessionVersion;
  const editor = editorVersion;
  const current = () => version === sessionVersion && editor === editorVersion;
  document.querySelector("#edit-file-name").value = file.fileName;
  document.querySelector("#file-download").href = `/api/library/${file.id}/file`;
  document.querySelector("#file-download").setAttribute("download", file.fileName);
  document.querySelector("#file-save").disabled = false;
  fileEditor.disabled = false;
  fileDialog.showModal();
  const message = document.querySelector("#preview-message");
  if (file.previewType === "text") {
    message.textContent = "正在读取文本…";
    document.querySelector("#file-save").disabled = true;
    try {
      const payload = await api(`/api/library/${file.id}/content`);
      if (!current()) return;
      editingFile = payload.file;
      document.querySelector("#edit-file-name").value = payload.file.fileName;
      fileEditor.value = payload.text;
      editorOriginalText = payload.text;
      editorCanEdit = true;
      document.querySelector("#text-editor-label").hidden = false;
      message.textContent = `UTF-8 文本 · 可直接编辑，最大 ${formatSize(settings.maxTextBytes)}`;
    } catch (error) {
      if (!current()) return;
      if (error.status === 401) showLogin();
      else message.textContent = error.message;
    } finally {
      if (current()) document.querySelector("#file-save").disabled = false;
    }
  } else if (file.previewType === "image") {
    message.textContent = "图片预览 · 可修改文件名";
    const image = document.createElement("img");
    image.alt = file.fileName;
    image.src = `/api/library/${file.id}/preview?revision=${file.revision}`;
    image.addEventListener("error", () => {
      if (current()) message.textContent = "图片暂时无法预览，请下载查看。";
    });
    document.querySelector("#image-preview").append(image);
  } else {
    message.textContent = "此格式或大小暂不支持在线预览，可下载查看或修改文件名。";
  }
}

document.querySelector("#file-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = document.querySelector("#file-save");
  if (!editingFile || button.disabled || role !== "admin") return;
  const version = sessionVersion;
  const editor = editorVersion;
  const body = { fileName: document.querySelector("#edit-file-name").value.trim(), revision: editingFile.revision };
  if (editorCanEdit && fileEditor.value !== editorOriginalText) body.text = fileEditor.value;
  if (body.text !== undefined && new TextEncoder().encode(body.text).length > settings.maxTextBytes) {
    document.querySelector("#file-error").textContent = `文本超过 ${formatSize(settings.maxTextBytes)} 限制`;
    return;
  }
  button.disabled = true;
  editorBusy = true;
  fileEditor.disabled = true;
  document.querySelector("#file-error").textContent = "";
  try {
    await api(`/api/library/${editingFile.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (version !== sessionVersion || editor !== editorVersion) return;
    clearEditor();
    await loadLibrary();
    if (version === sessionVersion) showToast("文件已保存");
  } catch (error) {
    if (version !== sessionVersion || editor !== editorVersion) return;
    if (error.status === 401) showLogin();
    else document.querySelector("#file-error").textContent = error.message;
  } finally {
    if (version === sessionVersion && editor === editorVersion) {
      button.disabled = false;
      editorBusy = false;
      fileEditor.disabled = false;
    }
  }
});

function openAdmin() {
  document.querySelector("#admin-error").textContent = "";
  adminDialog.showModal();
}
document.querySelector("#login-admin").addEventListener("click", openAdmin);
document.querySelector("#admin-button").addEventListener("click", openAdmin);
document.querySelector("#admin-close").addEventListener("click", () => {
  if (!document.querySelector("#admin-form").querySelector("button[type=submit]").disabled) adminDialog.close();
});
adminDialog.addEventListener("close", () => { document.querySelector("#password").value = ""; });
adminDialog.addEventListener("cancel", (event) => {
  if (document.querySelector("#admin-form").querySelector("button[type=submit]").disabled) event.preventDefault();
});
document.querySelector("#admin-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector("button[type=submit]");
  if (button.disabled) return;
  button.disabled = true;
  document.querySelector("#admin-error").textContent = "";
  closeEvents();
  try {
    await api("/api/auth/admin", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: document.querySelector("#username").value, password: document.querySelector("#password").value }),
    });
    const session = await api("/api/session");
    if (!session.authenticated || session.role !== "admin") throw new Error("管理员登录状态未保存，请检查 Cookie 设置");
    adminDialog.close();
    await showApp(session);
    if (authenticated && role === "admin") switchPanel("library");
  } catch (error) {
    document.querySelector("#admin-error").textContent = error.message;
    if (authenticated) connectEvents();
  } finally {
    document.querySelector("#password").value = "";
    button.disabled = false;
  }
});
document.querySelector("#file-close").addEventListener("click", closeEditor);
fileDialog.addEventListener("cancel", (event) => { event.preventDefault(); closeEditor(); });
document.querySelector("#clipboard-tab").addEventListener("click", () => switchPanel("clipboard"));
document.querySelector("#library-tab").addEventListener("click", () => switchPanel("library"));
document.querySelector("#library-search").addEventListener("input", renderLibrary);
document.querySelector("#library-upload").addEventListener("click", () => libraryInput.click());
libraryInput.addEventListener("change", () => uploadFiles(libraryInput.files, true));

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
    document.querySelector("#login-admin").hidden = session.adminEnabled === false;
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
