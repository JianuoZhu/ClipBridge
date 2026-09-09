import { expect, test, type Page } from "@playwright/test";
import { createHash, randomBytes } from "node:crypto";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M/wn4GBgYGJAQoAHgQCAcPVpGQAAAAASUVORK5CYII=", "base64");
async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问 PIN").fill("1223");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "发送", exact: true })).toBeVisible();
}
async function direct(page: Page) {
  await expect(page.getByRole("button", { name: /连接状态：家中直连/ })).toBeVisible();
}
async function blockBusinessHttp(page: Page) {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (/^\/api\/(items|library|events)(?:\/|$)/.test(pathname)) await route.abort();
    else await route.continue();
  });
}
function pdfBytes() {
  const stream = "BT /F1 24 Tf 48 150 Td (Direct home PDF) Tj ET\n";
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  let body = "%PDF-1.7\n"; const offsets: number[] = [];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 6\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test("two independent home connections persist data after sender closes; file, image and PDF bypass HTTP", async ({ browser }, testInfo) => {
  const senderContext = await browser.newContext({ serviceWorkers: "block" });
  const receiverContext = await browser.newContext({ serviceWorkers: "block" });
  // Exercise the bounded Blob download path deterministically in headless Chromium.
  await receiverContext.addInitScript(() => { Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true }); });
  try {
    const sender = await senderContext.newPage();
    const receiver = await receiverContext.newPage();
    await login(sender); await login(receiver);
    await direct(sender); await direct(receiver);
    await blockBusinessHttp(sender); await blockBusinessHttp(receiver);
    const message = `P2P persisted ${Date.now()}`;
    await sender.getByLabel("发送文字").fill(message);
    await sender.getByRole("button", { name: "发送", exact: true }).click();
    await expect(sender.getByRole("status").filter({ hasText: "文字已保存到家中" })).toBeVisible();
    await expect(receiver.locator(".content-card").filter({ hasText: message }).first()).toBeVisible();

    const file = randomBytes(3 * 1024 * 1024 + 17);
    await sender.locator('input[type="file"]').first().setInputFiles({ name: "p2p-persisted.bin", mimeType: "application/octet-stream", buffer: file });
    await expect(sender.getByRole("status").filter({ hasText: "p2p-persisted.bin 已保存到家中" })).toBeVisible();
    await sender.locator('input[type="file"]').first().setInputFiles({ name: "p2p-image.png", mimeType: "image/png", buffer: png });
    await expect(sender.getByRole("status").filter({ hasText: "p2p-image.png 已保存到家中" })).toBeVisible();
    await sender.locator('input[type="file"]').first().setInputFiles({ name: "p2p-range.pdf", mimeType: "application/pdf", buffer: pdfBytes() });
    await expect(sender.getByRole("status").filter({ hasText: "p2p-range.pdf 已保存到家中" })).toBeVisible();
    await senderContext.close();
    // Start a fresh receiving connection after the source device is gone.
    await receiver.reload();
    await direct(receiver);

    const imageCard = receiver.locator(".content-card").filter({ hasText: "p2p-image.png" }).first();
    await expect(imageCard).toBeVisible();
    await imageCard.getByRole("button", { name: "预览 p2p-image.png" }).click();
    await expect(receiver.getByRole("img", { name: "p2p-image.png" })).toBeVisible();
    expect(await receiver.getByRole("img", { name: "p2p-image.png" }).evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(2);
    await receiver.getByRole("button", { name: "关闭", exact: true }).first().click();
    await receiver.locator(".content-card").filter({ hasText: "p2p-range.pdf" }).first().getByRole("button", { name: "预览 p2p-range.pdf" }).click();
    await expect(receiver.locator(".react-pdf__Page canvas")).toBeVisible();
    await receiver.getByRole("button", { name: "关闭", exact: true }).first().click();

    const downloadPromise = receiver.waitForEvent("download");
    await receiver.locator(".content-card").filter({ hasText: "p2p-persisted.bin" }).first().getByRole("link", { name: "下载", exact: true }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("p2p-persisted.bin");
    const stream = await download.createReadStream();
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk);
    expect(hash.digest("hex")).toBe(createHash("sha256").update(file).digest("hex"));
    await receiver.getByRole("button", { name: /连接状态：家中直连/ }).click();
    await expect(receiver.getByRole("dialog")).toContainText("这台设备与家中服务器的传输路径");
    const screenshot = testInfo.outputPath("p2p-connection-state.png");
    await receiver.screenshot({ path: screenshot, animations: "disabled" });
    await testInfo.attach("p2p-connection-state", { path: screenshot, contentType: "image/png" });
  } finally { await senderContext.close(); await receiverContext.close(); }
});

test("unreachable gateway falls back to HTTP and displays the actual route", async ({ page }) => {
  await page.route("**/api/p2p/offer", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "test unavailable" }) }));
  await login(page);
  await expect(page.getByRole("button", { name: /连接状态：HTTPS 备用/ })).toBeVisible();
  const message = `Fallback ${Date.now()}`;
  const request = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/items/text" && response.status() === 201);
  await page.getByLabel("发送文字").fill(message);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await request;
  await expect(page.locator(".content-card").filter({ hasText: message }).first()).toBeVisible();
});

test("an established connection can fail and a later operation uses HTTPS", async ({ page }) => {
  await page.addInitScript(() => {
    const Original = window.RTCPeerConnection;
    const peers: RTCPeerConnection[] = [];
    (window as unknown as { testPeers: RTCPeerConnection[] }).testPeers = peers;
    window.RTCPeerConnection = class extends Original { constructor(config?: RTCConfiguration) { super(config); peers.push(this); } };
  });
  await login(page); await direct(page);
  await page.route("**/api/p2p/offer", (route) => route.abort());
  await page.evaluate(() => { for (const peer of (window as unknown as { testPeers: RTCPeerConnection[] }).testPeers) peer.close(); });
  await expect(page.getByRole("button", { name: /连接状态：HTTPS 备用/ })).toBeVisible();
  const request = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/items/text" && response.status() === 201);
  await page.getByLabel("发送文字").fill(`After disconnect ${Date.now()}`);
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await request;
  await expect(page.getByRole("status").filter({ hasText: "文字已保存到家中" })).toBeVisible();
});

test("existing WebRTC connections preserve admin restrictions and cannot outlive session revocation", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(async () => {
    const login = await fetch("/api/auth/login", { method: "POST", headers: { "X-Clip-Request": "1", "Content-Type": "application/json" }, body: JSON.stringify({ pin: "1223" }) });
    if (!login.ok) throw new Error("Test login failed");
    const pc = new RTCPeerConnection({ iceServers: [] });
    const control = pc.createDataChannel("clip-control-v1");
    const opened = new Promise<void>((resolve, reject) => {
      control.onopen = () => resolve();
      control.onerror = () => reject(new Error("Test connection failed"));
    });
    await pc.setLocalDescription(await pc.createOffer());
    if (pc.iceGatheringState !== "complete") await new Promise<void>((resolve) => {
      pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === "complete") resolve(); };
    });
    const negotiated = await fetch("/api/p2p/offer", { method: "POST", headers: { "X-Clip-Request": "1", "Content-Type": "application/json" },
      body: JSON.stringify({ offer: { type: "offer", sdp: pc.localDescription!.sdp } }) });
    if (!negotiated.ok) throw new Error("Test negotiation failed");
    await pc.setRemoteDescription((await negotiated.json()).answer);
    await opened;
    const testWindow = window as unknown as { testRequest: (path: string) => Promise<number>; closeTestPeer: () => void };
    testWindow.closeTestPeer = () => pc.close();
    testWindow.testRequest = (path) => new Promise<number>((resolve, reject) => {
      const channel = pc.createDataChannel("clip-http-v1");
      channel.binaryType = "arraybuffer";
      let status = 0;
      channel.onopen = () => { channel.send(JSON.stringify({ type: "request", method: "GET", path, headers: {}, bodySize: 0 })); channel.send(JSON.stringify({ type: "end" })); };
      channel.onmessage = ({ data }) => {
        if (typeof data !== "string") return;
        const frame = JSON.parse(data);
        if (frame.type === "response") status = frame.status;
        if (frame.type === "end") { resolve(status); channel.close(); }
        if (frame.type === "error") { reject(new Error(frame.message)); channel.close(); }
      };
      channel.onerror = () => reject(new Error("Test transfer failed"));
    });
  });
  const getStatus = (path: string) => page.evaluate((path) => (window as unknown as { testRequest: (path: string) => Promise<number> }).testRequest(path), path);
  expect(await getStatus("/api/items")).toBe(200);
  expect(await getStatus("/api/library")).toBe(403);
  expect(await page.evaluate(async () => (await fetch("/api/auth/logout", { method: "POST", headers: { "X-Clip-Request": "1" } })).status)).toBe(204);
  expect(await getStatus("/api/items")).toBe(401);
  expect(await getStatus("/api/library")).toBe(401);
  await page.evaluate(() => (window as unknown as { closeTestPeer: () => void }).closeTestPeer());
});
