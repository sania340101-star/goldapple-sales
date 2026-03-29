import puppeteer from "puppeteer";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");

const SITE_URL = "https://goldapple.ru";
const SALE_URL = `${SITE_URL}/sale`;
const API_BASE = `${SITE_URL}/front/api/catalog/products`;
const MOSCOW_CITY_ID = "0c5b2444-70a0-4932-980c-b4dc0d3f02b5";

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

async function main() {
  console.log("=== Gold Apple Scraper (Puppeteer) ===");
  await mkdir(DATA_DIR, { recursive: true });

  // Launch real Chrome
  console.log("[1] Launching Chrome...");
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });

  const page = await browser.newPage();

  // Stealth
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    (window as any).chrome = { runtime: {} };
  });

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
  );

  // Intercept API calls to discover categoryId
  let discoveredCategoryId: string | null = null;
  const apiResponses: any[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/front/api/catalog/products")) {
      console.log(`  [API intercepted] ${url}`);
      const match = url.match(/categoryId=([^&]+)/);
      if (match) discoveredCategoryId = match[1];
      try {
        const json = await response.json();
        apiResponses.push(json);
      } catch {}
    }
  });

  // Navigate to sale page
  console.log("[2] Navigating to goldapple.ru/sale...");
  await page.goto(SALE_URL, { waitUntil: "domcontentloaded", timeout: 90_000 });

  // Wait for GIB challenge
  console.log("[3] Waiting for GIB challenge...");
  try {
    await page.waitForFunction(
      () => {
        const links = document.querySelectorAll("a[href]").length;
        const imgs = document.querySelectorAll("img").length;
        return links > 10 || imgs > 3;
      },
      { timeout: 60_000 }
    );
    console.log("  GIB passed!");
  } catch {
    console.log("  GIB timeout, trying to continue anyway...");
  }

  // Wait for content to load
  await delay(5_000);
  await page.evaluate(() => window.scrollTo(0, 800));
  await delay(3_000);

  // Get cookies
  const cookies = await page.cookies();
  console.log(`[4] Got ${cookies.length} cookies`);

  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  // Close browser
  await browser.close();
  console.log("  Browser closed.");

  // Now fetch API with cookies
  const categoryId = discoveredCategoryId || "cat570001";
  console.log(`[5] Fetching API with categoryId=${categoryId}...`);

  const allProducts: Product[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  // Also check if we already got data from intercepted responses
  for (const resp of apiResponses) {
    const items = resp?.data?.products ?? resp?.products ?? [];
    for (const item of items) {
      const product = parseProduct(item, now);
      if (product && !seenIds.has(product.id)) {
        seenIds.add(product.id);
        allProducts.push(product);
      }
    }
  }
  if (allProducts.length > 0) {
    console.log(`  Got ${allProducts.length} products from intercepted responses`);
  }

  // Fetch remaining pages via API
  for (let pageNum = 0; pageNum < 50; pageNum++) {
    const url = `${API_BASE}?categoryId=${categoryId}&cityId=${MOSCOW_CITY_ID}&pageNumber=${pageNum}`;
    try {
      const resp = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          Accept: "application/json",
          "Accept-Language": "ru-RU,ru;q=0.9",
          Referer: SALE_URL,
          Origin: SITE_URL,
          Cookie: cookieString,
        },
      });

      if (!resp.ok) {
        console.log(`  Page ${pageNum}: HTTP ${resp.status}, stopping.`);
        break;
      }

      const json: any = await resp.json();
      const items = json?.data?.products ?? json?.products ?? [];

      if (items.length === 0) {
        console.log(`  Page ${pageNum}: empty, done.`);
        break;
      }

      let added = 0;
      for (const item of items) {
        const product = parseProduct(item, now);
        if (product && !seenIds.has(product.id)) {
          seenIds.add(product.id);
          allProducts.push(product);
          added++;
        }
      }

      console.log(`  Page ${pageNum}: ${items.length} items, +${added} new (total: ${allProducts.length})`);
      await delay(1_500);
    } catch (err) {
      console.error(`  Page ${pageNum} error:`, err);
      break;
    }
  }

  // Save
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== Done! Saved ${sorted.length} products ===`);
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
    category: "Sale",
    rating: item.reviews?.rating ?? 0,
    reviewsCount: item.reviews?.reviewsCount ?? 0,
    scrapedAt: now,
  };
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
