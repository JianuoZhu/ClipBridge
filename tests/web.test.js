import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";

const appSource = await fs.readFile(new URL("../web/app.js", import.meta.url), "utf8");
const workerSource = await fs.readFile(new URL("../web/sw.js", import.meta.url), "utf8");
const flush = () => new Promise((resolve) => setImmediate(resolve));
const response = (body, status = 200) => Response.json(body, { status });
const session = {
  authenticated: true,
  settings: { retentionHours: 24, maxFileBytes: 1024, maxTextBytes: 1024 },
};
const item = (text) => ({
  id: text, kind: "text", text, createdAt: Date.now(), expiresAt: Date.now() + 86400000,
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

class Element {
  children = [];
  listeners = new Map();
  attributes = new Map();
  style = {};
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  classList = {
    values: new Set(),
    add(value) { this.values.add(value); },
    remove(value) { this.values.delete(value); },
    toggle(value, enabled) { enabled ? this.add(value) : this.remove(value); },
    contains(value) { return this.values.has(value); },
  };
  querySelector(selector) {
    this.queries ??= new Map();
    if (!this.queries.has(selector)) this.queries.set(selector, new Element());
    return this.queries.get(selector);
  }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  emit(name, event = {}) {
    return Promise.all((this.listeners.get(name) || []).map((handler) =>
      handler({ currentTarget: this, preventDefault() {}, ...event })));
  }
  append(...children) {
    for (const child of children) child.parent = this;
    this.children.push(...children);
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() {
    if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this);
  }
  setAttribute(name, value) { this.attributes.set(name, value); }
  focus() {}
  select() {}
}

async function browser() {
  const document = new Element();
  document.createElement = () => new Element();
  document.body = new Element();
  document.execCommand = () => false;
  const eventSources = [];
  class EventSource extends Element {
    static OPEN = 1;
    static CLOSED = 2;
    readyState = 0;
    constructor() { super(); eventSources.push(this); }
    close() { this.readyState = EventSource.CLOSED; }
  }
  const requests = [];
  class XMLHttpRequest extends Element {
    upload = new Element();
    constructor() { super(); requests.push(this); }
    open() {}
    setRequestHeader() {}
    send() {}
    abort() { this.aborted = true; this.emit("abort"); }
  }
  const timers = new Map();
  let timerId = 0;
  const context = vm.createContext({
    document,
    window: Object.assign(new Element(), { confirm: () => true }),
    navigator: {},
    Headers, TextEncoder, EventSource, XMLHttpRequest,
    fetch: async () => response({ authenticated: false }),
    setTimeout: (callback, delay) => {
      const id = ++timerId;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(appSource, context);
  await flush();
  context.fetch = async () => response({ items: [] });
  return {
    context, document, eventSources, requests, timers,
    element: (id) => document.querySelector(`#${id}`),
    signIn: () => context.showApp(session),
  };
}

test("an update during an in-flight list request is fetched before refresh completes", async () => {
  const page = await browser();
  const first = deferred();
  let calls = 0;
  page.context.fetch = async () => ++calls === 1 ? first.promise : response({ items: [item("new")] });
  const loading = page.signIn();
  const refreshing = page.context.loadItems();
  first.resolve(response({ items: [] }));
  await Promise.all([loading, refreshing]);
  assert.equal(calls, 2);
  assert.equal(page.element("items").children.length, 1);
  assert.equal(page.element("empty-state").hidden, true);
});

test("late requests from a previous session cannot replace a new session's list", async () => {
  const page = await browser();
  const oldRequest = deferred();
  page.context.fetch = () => oldRequest.promise;
  const previousSession = page.signIn();
  page.context.showLogin();
  page.context.fetch = async () => response({ items: [item("current")] });
  await page.signIn();
  oldRequest.resolve(response({ items: [] }));
  await previousSession;
  assert.equal(page.element("items").children.length, 1);
  assert.equal(page.element("app-view").hidden, false);
});

test("401 during initial loading closes the event stream and keeps the login view", async () => {
  const page = await browser();
  page.context.fetch = async () => response({ error: "请先登录" }, 401);
  await page.signIn();
  assert.equal(page.element("login-view").hidden, false);
  assert.equal(page.element("app-view").hidden, true);
  assert.equal(page.eventSources.length, 1);
  assert.equal(page.eventSources[0].readyState, 2);
});

test("event-stream reconnection reloads missed items and session expiry clears them", async () => {
  const page = await browser();
  await page.signIn();
  let calls = 0;
  page.context.fetch = async () => { calls += 1; return response({ items: [item("updated")] }); };
  page.eventSources[0].readyState = 1;
  await page.eventSources[0].emit("ready");
  await flush();
  assert.equal(calls, 1);
  assert.equal(page.element("items").children.length, 1);
  await page.eventSources[0].emit("session-expired");
  assert.equal(page.element("items").children.length, 0);
  assert.equal(page.element("app-view").hidden, true);
});

test("a closed event stream checks expired authentication instead of retrying forever", async () => {
  const page = await browser();
  await page.signIn();
  page.context.fetch = async (url) => {
    assert.equal(url, "/api/session");
    return response({ authenticated: false });
  };
  page.eventSources[0].readyState = 2;
  page.eventSources[0].onerror();
  await flush();
  assert.equal(page.element("app-view").hidden, true);
  assert.equal(page.eventSources.length, 1);
});

test("repeat sends are suppressed and text typed during a send is preserved", async () => {
  const page = await browser();
  await page.signIn();
  const saving = deferred();
  let posts = 0;
  page.context.fetch = async (url) => {
    if (url === "/api/items/text") { posts += 1; return saving.promise; }
    return response({ items: [] });
  };
  page.element("text-input").value = "first draft";
  const sent = page.context.sendText();
  await page.context.sendText();
  page.element("text-input").value = "next draft";
  saving.resolve(response({ item: item("first draft") }, 201));
  await sent;
  assert.equal(posts, 1);
  assert.equal(page.element("text-input").value, "next draft");
  assert.equal(page.element("send-text").disabled, false);
});

test("text size validation counts UTF-8 bytes", async () => {
  const page = await browser();
  await page.context.showApp({ ...session, settings: { ...session.settings, maxTextBytes: 4 } });
  let calls = 0;
  page.context.fetch = async () => { calls += 1; return response({}); };
  page.element("text-input").value = "中文";
  await page.context.sendText();
  assert.equal(calls, 0);
  assert.match(page.element("toast").textContent, /文字超过/);
});

test("a failed clipboard fallback reports failure and removes its helper", async () => {
  const page = await browser();
  await page.context.copyText("private text");
  assert.match(page.element("toast").textContent, /复制失败/);
  assert.equal(page.element("toast").classList.contains("error"), true);
  assert.equal(page.document.body.children.length, 0);
});

test("a failed logout leaves the active view available for retry", async () => {
  const page = await browser();
  await page.signIn();
  page.context.fetch = async () => { throw new Error("offline"); };
  await page.element("logout-button").emit("click");
  assert.equal(page.element("app-view").hidden, false);
  assert.equal(page.element("logout-button").disabled, false);
  assert.match(page.element("toast").textContent, /退出失败/);
});

test("login does not enter the app when the browser did not retain the session cookie", async () => {
  const page = await browser();
  page.context.fetch = async (url) => response(url === "/api/auth/login" ? session : { authenticated: false });
  await page.element("login-form").emit("submit");
  assert.match(page.element("login-error").textContent, /登录状态未保存/);
  assert.equal(page.eventSources.length, 0);
});

test("leaving an authenticated session aborts uploads and cancels remaining files", async () => {
  const page = await browser();
  await page.signIn();
  const uploading = page.context.uploadFiles([
    { name: "first.txt", size: 10 }, { name: "second.txt", size: 10 },
  ]);
  assert.equal(page.requests.length, 1);
  page.context.showLogin();
  await uploading;
  assert.equal(page.requests[0].aborted, true);
  assert.equal(page.requests.length, 1);
  assert.equal(page.element("upload-list").children.length, 0);
  assert.equal(page.element("toast").textContent, "");
});

test("service-worker activation only deletes this app's outdated caches", async () => {
  const handlers = new Map();
  const deleted = [];
  let claimed = false;
  const context = vm.createContext({
    self: {
      addEventListener: (name, handler) => handlers.set(name, handler),
      clients: { claim: async () => { claimed = true; } },
    },
    caches: {
      keys: async () => ["other-app-v1", "jianuo-clip-v1", "jianuo-clip-v2"],
      delete: async (key) => { deleted.push(key); },
    },
  });
  vm.runInContext(workerSource, context);
  let pending;
  handlers.get("activate")({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted, ["jianuo-clip-v1"]);
  assert.equal(claimed, true);
});

test("service worker excludes API and unrelated paths, returning a Response on an offline cache miss", async () => {
  const handlers = new Map();
  const context = vm.createContext({
    URL, Response,
    self: {
      location: { origin: "https://clip.example" },
      addEventListener: (name, handler) => handlers.set(name, handler),
    },
    fetch: async () => { throw new Error("offline"); },
    caches: { open: async () => ({ match: async () => undefined }) },
  });
  vm.runInContext(workerSource, context);
  let pending;
  const request = (pathname) => ({
    request: { method: "GET", url: `https://clip.example${pathname}` },
    respondWith: (promise) => { pending = promise; },
  });
  handlers.get("fetch")(request("/api/items"));
  assert.equal(pending, undefined);
  handlers.get("fetch")(request("/unrelated"));
  assert.equal(pending, undefined);
  handlers.get("fetch")(request("/app.js"));
  assert.equal((await pending).type, "error");
});
