import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

puppeteer.use(StealthPlugin());

const DATA_DIR = join(import.meta.dir, "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");

const SITE_URL = "https://goldapple.ru";
const SALE_URL = `${SITE_URL}/sale`;
const API_BASE = `${SITE_URL}/front/api/catalog/products`;
const MOSCOW_CITY_ID = "0c5b2444-70a0-4932-980c-b4dc0d3f02b5";

const API_REQUEST_DELAY_MS = 1_500;
const MAX_PAGES = 50;

interface Product {
  id: string;
  name: string;
  brand: string;
  price: number;
  oldPrice: number;
  discount: number;
  imageUrl: string;
  productUrl: string;
  category: string;
  rating: number;
  reviewsCount: number;
  scrapedAt: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProduct(item: any, now: string): Product | null {
  const price = item.price;
  if (!price) return null;

  const currentPrice = price.actual?.amount ?? price.current?.amount;
  const oldPrice = price.old?.amount ?? price.previous?.amount;
  if (!oldPrice || !currentPrice || oldPrice <= currentPrice) return null;

  const discount =
    price.viewOptions?.discountPercent ??
    Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
  if (discount < 1 || discount > 99) return null;

  const id = String(item.itemId ?? item.id ?? "");
  if (!id) return null;

  const rawImgUrl = item.imageUrls?.[0]?.url ?? "";
  const imageUrl = rawImgUrl
    .replace("${screen}", "fullhd")
    .replace("${format}", "webp");

  return {
    id,
    name: item.name ?? "",
    brand: item.brand ?? "",
    price: currentPrice,
    oldPrice,
    discount,
    imageUrl,
    productUrl: item.url ? `${SITE_URL}${item.url}` : "",
    category: item.category?.name ?? "Sale",
    rating: item.reviews?.rating ?? 0,
    reviewsCount: item.reviews?.reviewsCount ?? 0,
    scrapedAt: now,
  };
}

async function main() {
  console.log("=== Gold Apple Scraper (stealth) ===");
  console.log(`Time: ${new Date().toLocaleString("ru-RU")}`);

  await mkdir(DATA_DIR, { recursive: true });

  // Phase 1: Launch browser with stealth and get cookies
  console.log("[Phase 1] Launching stealth browser...");

  // Use the real Chrome executable
  const chromeExe = "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe";

  const browser = await puppeteer.launch({
    executablePath: chromeExe,
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
      "--lang=ru-RU",
    ],
    defaultViewport: { width: 1920, height: 1080 },
    ignoreDefaultArgs: ["--enable-automation"],
  });

  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  });

  // Intercept API calls
  let categoryId: string | null = null;
  const interceptedProducts: any[] = [];

  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("/front/api/catalog/products") && url.includes("categoryId=")) {
      const match = url.match(/categoryId=([^&]+)/);
      if (match && !categoryId) {
        categoryId = match[1];
        console.log(`  [Discovery] categoryId: ${categoryId}`);
      }
    }
  });

  page.on("response", async (res) => {
    const url = res.url();
    if (url.includes("/front/api/catalog/products")) {
      try {
        const json = await res.json();
        const products = json?.data?.products ?? json?.products ?? [];
        if (products.length > 0) {
          interceptedProducts.push(...products);
          console.log(`  [Intercept] Got ${products.length} products from API`);
        }
      } catch {}
    }
  });

  console.log("  Navigating to sale page...");
  try {
    await page.goto(SALE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  } catch (e: any) {
    console.log(`  Navigation partial: ${e.message?.slice(0, 100)}`);
  }

  // Wait for GIB to pass
  console.log("  Waiting for GIB challenge...");
  const start = Date.now();
  let passed = false;
  for (let i = 0; i < 90; i++) {
    await delay(2000);
    const title = await page.title();
    const links = await page.evaluate(() => document.querySelectorAll("a[href]").length);
    const elapsed = ((Date.now() - start) / 1000).toFixed(0);

    if (i % 5 === 0) {
      console.log(`  [${elapsed}s] title="${title}", links=${links}`);
    }

    if (links > 10 || !title.toLowerCase().includes("checking")) {
      console.log(`  GIB passed in ${elapsed}s!`);
      passed = true;
      break;
    }
  }

  if (passed) {
    // Scroll to trigger lazy loading
    await page.evaluate(() => window.scrollTo(0, 600));
    await delay(3000);
    await page.evaluate(() => window.scrollTo(0, 1200));
    await delay(3000);
    await page.evaluate(() => window.scrollTo(0, 2400));
    await delay(3000);
  }

  // Get cookies
  const cookies = await page.cookies();
  console.log(`  Got ${cookies.length} cookies`);

  // Take screenshot for debug
  await page.screenshot({ path: join(DATA_DIR, "debug-last.png"), fullPage: false });

  await browser.close();
  console.log("  Browser closed.");

  // Phase 2: Use cookies to call API
  const cookieStr = cookies.map((c: any) => `${c.name}=${c.value}`).join("; ");
  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: SALE_URL,
    Origin: SITE_URL,
    Cookie: cookieStr,
  };

  const now = new Date().toISOString();
  let allProducts: Product[] = [];
  const seenIds = new Set<string>();

  // Parse intercepted products first
  for (const item of interceptedProducts) {
    const p = parseProduct(item, now);
    if (p && !seenIds.has(p.id)) {
      seenIds.add(p.id);
      allProducts.push(p);
    }
  }
  if (allProducts.length > 0) {
    console.log(`[Intercepted] ${allProducts.length} discounted products`);
  }

  // Try API pagination
  if (passed) {
    console.log("[Phase 2] Fetching via API...");
    const idsToTry = categoryId
      ? [categoryId, "cat570001"]
      : ["cat570001", "1000", "sale"];

    for (const catId of idsToTry) {
      console.log(`  Trying categoryId=${catId}...`);
      let pageNum = 0;

      while (pageNum < MAX_PAGES) {
        try {
          const url = `${API_BASE}?categoryId=${catId}&cityId=${MOSCOW_CITY_ID}&pageNumber=${pageNum}`;
          const res = await fetch(url, { headers });

          if (!res.ok) {
            console.log(`  Page ${pageNum}: HTTP ${res.status}`);
            break;
          }

          const json: any = await res.json();
          const items = json?.data?.products ?? json?.products ?? [];

          if (items.length === 0) break;

          let pageNew = 0;
          for (const item of items) {
            const p = parseProduct(item, now);
            if (p && !seenIds.has(p.id)) {
              seenIds.add(p.id);
              allProducts.push(p);
              pageNew++;
            }
          }

          console.log(`  Page ${pageNum}: ${items.length} items, ${pageNew} new (total: ${allProducts.length})`);
          pageNum++;
          await delay(API_REQUEST_DELAY_MS);
        } catch (e: any) {
          console.log(`  Error: ${e.message?.slice(0, 100)}`);
          break;
        }
      }

      if (allProducts.length > 0) break;
    }
  }

  // Phase 3: Save
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== Done. ${sorted.length} products saved ===`);
}

main().catch((err) => {
  console.error("Scraper failed:", err);
  process.exit(1);
});
