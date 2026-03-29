import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
});

console.log("Browser launched OK");

const context = await browser.newContext({
  locale: "ru-RU",
  timezoneId: "Europe/Moscow",
  viewport: { width: 1920, height: 1080 },
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, "webdriver", { get: () => false });
  (window as any).chrome = { runtime: {} };
});

const page = await context.newPage();
console.log("Navigating to goldapple.ru/sale...");

// Intercept API requests
let categoryId: string | null = null;
const apiResponses: any[] = [];

page.on("request", (req) => {
  const url = req.url();
  if (url.includes("/front/api/catalog/products")) {
    const match = url.match(/categoryId=([^&]+)/);
    if (match) categoryId = match[1];
    console.log("  API request:", url);
  }
});

page.on("response", async (resp) => {
  const url = resp.url();
  if (url.includes("/front/api/catalog/products")) {
    try {
      const json = await resp.json();
      apiResponses.push(json);
      console.log("  API response:", url, "products:", json?.data?.products?.length ?? 0);
    } catch {}
  }
});

await page.goto("https://goldapple.ru/sale", { waitUntil: "domcontentloaded", timeout: 60000 });
console.log("Page loaded, title:", await page.title());

// Wait for content
await page.waitForTimeout(10000);

// Scroll to trigger more loads
await page.evaluate(() => window.scrollTo(0, 1000));
await page.waitForTimeout(3000);

const cookies = await context.cookies();
console.log("Cookies:", cookies.length);
console.log("CategoryId found:", categoryId);
console.log("API responses captured:", apiResponses.length);

// Try API with these cookies
if (cookies.length > 0) {
  const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
  const testCatId = categoryId || "cat570001";
  const resp = await fetch(`https://goldapple.ru/front/api/catalog/products?categoryId=${testCatId}&cityId=0c5b2444-70a0-4932-980c-b4dc0d3f02b5&pageNumber=0`, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "Accept": "application/json",
      "Cookie": cookieStr,
      "Referer": "https://goldapple.ru/sale",
      "Origin": "https://goldapple.ru",
    }
  });
  console.log("Direct API status:", resp.status);
  if (resp.ok) {
    const data = await resp.json() as any;
    console.log("Products from API:", data?.data?.products?.length ?? 0);
  }
}

await browser.close();
console.log("Done");
