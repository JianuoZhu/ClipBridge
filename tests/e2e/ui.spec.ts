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
