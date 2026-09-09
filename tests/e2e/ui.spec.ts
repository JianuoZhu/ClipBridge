import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR42mNk+M/wn4GBgYGJAQoAHgQCAcPVpGQAAAAASUVORK5CYII=", "base64");

function minimalPdf() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 52 >>\nstream\nBT /F1 24 Tf 48 150 Td (ClipBridge PDF) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
  ];
  let body = "%PDF-1.7\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets[index + 1] = Buffer.byteLength(body);
    body += (index + 1) + " 0 obj\n" + object + "\nendobj\n";
  });
  const xref = Buffer.byteLength(body);
  body += "xref\n0 " + (objects.length + 1) + "\n0000000000 65535 f \n";
  offsets.slice(1).forEach((offset) => { body += String(offset).padStart(10, "0") + " 00000 n \n"; });
  body += "trailer\n<< /Size " + (objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xref + "\n%%EOF\n";
  return Buffer.from(body);
}

async function login(page: Page) {
  await page.goto("/");
  await page.getByLabel("访问 PIN").fill("1223");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "发送" })).toBeVisible();
}

async function newUser(context: BrowserContext) {
  const page = await context.newPage();
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && /content security policy/i.test(message.text())) violations.push(message.text());
  });
  await login(page);
  return { page, violations };
}

test("themes persist and the compact mobile workspace does not overflow", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ viewport: { width: 375, height: 780 }, serviceWorkers: "block", reducedMotion: "reduce" });
  const page = await context.newPage();
  await page.emulateMedia({ colorScheme: "dark", reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  await page.getByRole("button", { name: "切换主题" }).click();
  await page.getByText("梅紫", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "plum");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "plum");
  await page.getByRole("button", { name: "切换主题" }).click();
  await page.getByText("跟随系统", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "forest");
  await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
  await expect(page.locator("html")).toHaveAttribute("data-theme", "mint");
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.getByLabel("访问 PIN").fill("1223");
  await page.getByRole("button", { name: "进入工作台" }).click();
  await expect(page.getByRole("heading", { name: "发送" })).toBeVisible();
  expect(await page.getByLabel("发送文字").evaluate((node) => Number.parseFloat(getComputedStyle(node).fontSize))).toBeGreaterThanOrEqual(16);
  expect((await page.getByRole("button", { name: "切换主题" }).boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await testInfo.attach("mobile-mint-workspace", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await context.close();
});

test("loading indicators animate before opening a preview and respect reduced motion", async ({ browser }) => {
  const context = await browser.newContext({ serviceWorkers: "block", reducedMotion: "no-preference" });
  const page = await context.newPage();
  const previewAssets: string[] = [];
  page.on("request", (request) => {
    if (/\/assets\/PreviewDialog[^/]*\.(js|css)$/.test(new URL(request.url()).pathname)) previewAssets.push(request.url());
  });
  let releasePreview!: () => void;
  const previewGate = new Promise<void>((resolve) => { releasePreview = resolve; });
  await page.route(/\/api\/items\/[^/]+\/preview(?:\?|$)/, async (route) => {
    await previewGate;
    await route.continue();
  });
  try {
    await login(page);
    await page.locator('input[type="file"]').first().setInputFiles({ name: "loading-animation.png", mimeType: "image/png", buffer: png });
    const card = page.locator(".items-list .file-card").filter({ hasText: "loading-animation.png" }).first();
    const thumbnail = card.locator(".thumbnail-loading");
    const spinner = thumbnail.locator(".spin");
    await expect(spinner).toBeVisible();
    await expect(thumbnail).toHaveCSS("border-radius", "11px");
    await expect(thumbnail).toHaveCSS("width", "86px");
    await expect(spinner).toHaveCSS("animation-name", "spin");
    const transform = await spinner.evaluate((node) => getComputedStyle(node).transform);
    await expect.poll(() => spinner.evaluate((node) => getComputedStyle(node).transform)).not.toBe(transform);
    const backgroundPosition = await thumbnail.evaluate((node) => getComputedStyle(node).backgroundPosition);
    await expect.poll(() => thumbnail.evaluate((node) => getComputedStyle(node).backgroundPosition)).not.toBe(backgroundPosition);
    expect(previewAssets).toEqual([]);

    await page.emulateMedia({ reducedMotion: "reduce" });
    await expect(spinner).toHaveCSS("animation-iteration-count", "1");
    await expect.poll(() => spinner.evaluate((node) => node.getAnimations().every((animation) => animation.playState === "finished"))).toBe(true);
    await expect.poll(() => thumbnail.evaluate((node) => node.getAnimations().every((animation) => animation.playState === "finished"))).toBe(true);
    releasePreview();
    await expect(card.locator(".thumbnail img")).toBeVisible();

    await page.setViewportSize({ width: 390, height: 780 });
    await expect(card.locator(".thumbnail")).toHaveCSS("width", "82px");
    await card.getByRole("button", { name: "预览 loading-animation.png" }).click();
    await expect(page.getByRole("img", { name: "loading-animation.png" })).toBeVisible();
    await page.getByRole("button", { name: "关闭" }).click();
    await expect(card.locator(".thumbnail")).toHaveCSS("width", "82px");
  } finally {
    releasePreview();
    await context.close();
  }
});

test("large images fit the preview on desktop and mobile, and zoom remains clipped", async ({ page }, testInfo) => {
  await login(page);
  const assertFits = async () => {
    await expect.poll(() => page.locator(".image-content img").evaluate((image) => {
      const box = image.getBoundingClientRect();
      const viewport = document.querySelector(".image-viewport")!.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && box.left >= viewport.left - 1 && box.top >= viewport.top - 1 &&
        box.right <= viewport.right + 1 && box.bottom <= viewport.bottom + 1;
    })).toBe(true);
    expect(await page.getByRole("dialog").evaluate((element) => element.scrollWidth <= element.clientWidth + 1 && element.scrollHeight <= element.clientHeight + 1)).toBe(true);
  };
  for (const [width, height] of [[4096, 1024], [1000, 5000]]) {
    const data = await page.evaluate(([width, height]) => {
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const context = canvas.getContext("2d")!;
      const gradient = context.createLinearGradient(0, 0, width, height);
      gradient.addColorStop(0, "#146c55"); gradient.addColorStop(1, "#e6d18a");
      context.fillStyle = gradient; context.fillRect(0, 0, width, height);
      return canvas.toDataURL("image/jpeg").split(",")[1];
    }, [width, height]);
    const name = `large-${width}-${height}.jpg`;
    await page.locator('input[type="file"]').first().setInputFiles({ name, mimeType: "image/jpeg", buffer: Buffer.from(data, "base64") });
    await page.locator(".file-card").filter({ hasText: name }).first().getByRole("button", { name: `预览 ${name}` }).click();
    await expect(page.getByRole("img", { name, exact: true })).toBeVisible();
    await assertFits();
    await page.getByRole("button", { name: "放大", exact: true }).click();
    await expect(page.locator(".image-viewport")).toHaveCSS("overflow", "hidden");
    await page.getByRole("button", { name: "适应窗口" }).click();
    await assertFits();
    await page.setViewportSize({ width: 390, height: 780 });
    await page.getByRole("button", { name: "适应窗口" }).click();
    await assertFits();
    if (height > width) await page.screenshot({ path: testInfo.outputPath("large-image-mobile.png"), animations: "disabled" });
    await page.getByRole("button", { name: "关闭", exact: true }).click();
    await page.setViewportSize({ width: 1280, height: 720 });
  }
});

test("connection latency and speed tests report the actual HTTPS path", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: /连接状态：/ }).click();
  await page.getByRole("button", { name: "测试连接延迟" }).click();
  const result = page.getByRole("status").filter({ hasText: "平均" });
  await expect(result).toContainText("成功 5/5");
  await expect(result).toContainText("实测路径：HTTPS");
  await page.getByRole("button", { name: "测试传输速度" }).click();
  const speed = page.getByLabel("传输速度测试结果");
  await expect(speed).toContainText("下载");
  await expect(speed).toContainText("上传");
  await expect(speed).toContainText("实测路径：HTTPS");
  await expect.poll(async () => (await speed.innerText()).match(/MiB\/s/g)?.length ?? 0).toBe(2);
  await expect.poll(async () => (await speed.innerText()).match(/Mbps/g)?.length ?? 0).toBe(2);
  await expect(page.getByRole("button", { name: "测试传输速度" })).toBeEnabled();
});

test("canceling a speed test stops before upload and allows a new test", async ({ page }) => {
  await login(page);
  await page.getByRole("button", { name: /连接状态：/ }).click();
  const methods: string[] = [];
  let releaseDownload!: () => void;
  const downloadGate = new Promise<void>((resolve) => { releaseDownload = resolve; });
  let finishRoute!: () => void;
  const routeFinished = new Promise<void>((resolve) => { finishRoute = resolve; });
  const speedRoute = /\/api\/connection\/speed(?:\?|$)/;
  await page.route(speedRoute, async (route) => {
    methods.push(route.request().method());
    try {
      await downloadGate;
      await route.abort("aborted").catch(() => {});
    } finally { finishRoute(); }
  });
  try {
    const downloadRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/connection/speed");
    await page.getByRole("button", { name: "测试传输速度" }).click();
    expect((await downloadRequest).method()).toBe("GET");
    await page.getByRole("button", { name: "取消测试" }).click();
    await expect(page.getByRole("button", { name: "测试传输速度" })).toBeEnabled();
    releaseDownload();
    await routeFinished;
    expect(methods).toEqual(["GET"]);
    await page.unroute(speedRoute);

    await page.getByRole("button", { name: "测试传输速度" }).click();
    const result = page.getByLabel("传输速度测试结果");
    await expect(result).toContainText("下载");
    await expect(result).toContainText("上传");
    await expect.poll(async () => (await result.innerText()).match(/MiB\/s/g)?.length ?? 0).toBe(2);
    await expect(page.getByRole("button", { name: "测试传输速度" })).toBeEnabled();
  } finally {
    releaseDownload();
    await page.unroute(speedRoute);
  }
});

test("two devices receive animated messages and preview real images and PDFs", async ({ browser }, testInfo) => {
  const contextA = await browser.newContext({ serviceWorkers: "block" });
  const contextB = await browser.newContext({ serviceWorkers: "block" });
  const a = await newUser(contextA);
  const b = await newUser(contextB);

  await a.page.getByLabel("发送文字").fill("来自另一台设备的实时消息");
  await a.page.getByRole("button", { name: "发送", exact: true }).click();
  const received = b.page.locator(".content-card").filter({ hasText: "来自另一台设备的实时消息" }).first();
  await expect(received).toBeVisible();
  await expect(received).toHaveClass(/is-new/);

  await a.page.locator('input[type="file"]').first().setInputFiles({ name: "tiny.png", mimeType: "image/png", buffer: png });
  const imageCard = b.page.locator(".content-card").filter({ hasText: "tiny.png" }).first();
  await expect(imageCard).toBeVisible();
  await imageCard.getByRole("button", { name: "预览 tiny.png" }).click();
  const image = b.page.getByRole("img", { name: "tiny.png" });
  await expect(image).toBeVisible();
  expect(await image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBeGreaterThan(0);
  await b.page.getByRole("button", { name: "关闭" }).click();

  await a.page.locator('input[type="file"]').first().setInputFiles({ name: "manual.pdf", mimeType: "application/pdf", buffer: minimalPdf() });
  const pdfCard = b.page.locator(".content-card").filter({ hasText: "manual.pdf" }).first();
  await expect(pdfCard).toBeVisible();
  await pdfCard.getByRole("button", { name: "预览 manual.pdf" }).click();
  await expect(b.page.locator(".react-pdf__Page canvas")).toBeVisible();
  await expect(b.page.getByText("/ 1", { exact: false })).toBeVisible();
  expect(a.violations.concat(b.violations)).toEqual([]);
  await testInfo.attach("desktop-pdf-preview", { body: await b.page.screenshot(), contentType: "image/png" });
  await b.page.getByRole("button", { name: "关闭" }).click();

  await a.page.locator('input[type="file"]').first().setInputFiles({ name: "broken.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-not-a-document") });
  const brokenCard = b.page.locator(".content-card").filter({ hasText: "broken.pdf" }).first();
  await expect(brokenCard).toBeVisible();
  await brokenCard.getByRole("button", { name: "预览", exact: true }).click();
  await expect(b.page.getByText("PDF 暂时无法打开", { exact: false }).first()).toBeVisible();
  await expect(b.page.getByRole("link", { name: "下载" })).toBeVisible();
  
  await contextA.close();
  await contextB.close();
});
