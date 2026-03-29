import puppeteer from "puppeteer";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");

const SITE_URL = "https://goldapple.ru";
const SALE_URL = `${SITE_URL}/sale`;
const MOSCOW_CITY_ID = "0c5b2444-70a0-4932-980c-b4dc0d3f02b5";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseProduct(item: any, now: string): any | null {
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

async function main() {
  console.log("=== Gold Apple Scraper (CDP) ===");
  await mkdir(DATA_DIR, { recursive: true });

  // Kill existing Chrome
  try {
    Bun.spawnSync(["taskkill", "/F", "/IM", "chrome.exe"], { stdout: "pipe", stderr: "pipe" });
  } catch {}
  await delay(2_000);

  // Launch Chrome with user profile + debugging
  console.log("[1] Launching Chrome...");
  const chromeProcess = Bun.spawn([
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "--remote-debugging-port=9222",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdout: "pipe", stderr: "pipe" });

  await delay(5_000);

  // Connect via CDP
  console.log("[2] Connecting via CDP...");
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const page = await browser.newPage();

  // Track ALL API requests
  const apiUrls: string[] = [];
  const interceptedProducts: any[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    // Log all XHR/fetch to goldapple.ru API
    if (url.includes("goldapple.ru") && (url.includes("/api/") || url.includes("/front/"))) {
      apiUrls.push(url);
      if (url.includes("products") || url.includes("catalog")) {
        console.log(`  [API] ${url}`);
        try {
          const json = await response.json();
          // Check various response structures
          const items = json?.data?.products ?? json?.products ?? json?.data?.items ?? [];
          if (Array.isArray(items) && items.length > 0) {
            console.log(`    -> ${items.length} items found`);
            interceptedProducts.push(...items);
          }
          // Log response structure for debugging
          if (items.length === 0) {
            const keys = Object.keys(json?.data ?? json ?? {});
            console.log(`    -> keys: ${keys.join(", ")}`);
          }
        } catch {}
      }
    }
  });

  // Navigate
  console.log("[3] Navigating to goldapple.ru/sale...");
  await page.goto(SALE_URL, { waitUntil: "networkidle2", timeout: 120_000 });

  const title = await page.title();
  console.log(`  Page title: "${title}"`);

  // Wait and scroll
  console.log("[4] Scrolling to load more content...");
  await delay(3_000);

  for (let i = 0; i < 8; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), (i + 1) * 600);
    await delay(2_000);
  }

  // Log discovered API URLs
  console.log(`\n[5] Discovered ${apiUrls.length} API URLs:`);
  for (const url of apiUrls.slice(0, 20)) {
    console.log(`  ${url.substring(0, 150)}`);
  }

  // Get cookies
  const cookies = await page.cookies();
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  console.log(`\n[6] Got ${cookies.length} cookies`);

  // Collect products from intercepted
  const allProducts: any[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  for (const item of interceptedProducts) {
    const product = parseProduct(item, now);
    if (product && !seenIds.has(product.id)) {
      seenIds.add(product.id);
      allProducts.push(product);
    }
  }
  console.log(`  Intercepted products: ${allProducts.length}`);

  // Try to find the right API URL from intercepted ones
  const catalogUrls = apiUrls.filter((u) => u.includes("catalog") || u.includes("products"));
  if (catalogUrls.length > 0 && allProducts.length > 0) {
    // Extract categoryId from discovered URL
    const catMatch = catalogUrls[0].match(/categoryId=([^&]+)/);
    if (catMatch) {
      const categoryId = catMatch[1];
      console.log(`\n[7] Fetching more pages (categoryId=${categoryId})...`);

      for (let pageNum = 1; pageNum < 50; pageNum++) {
        const baseUrl = catalogUrls[0].replace(/pageNumber=\d+/, `pageNumber=${pageNum}`);
        const url = baseUrl.includes("pageNumber=")
          ? baseUrl
          : `${catalogUrls[0]}&pageNumber=${pageNum}`;

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
          const items = json?.data?.products ?? json?.products ?? json?.data?.items ?? [];

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

          console.log(`  Page ${pageNum}: ${items.length} items, +${added} (total: ${allProducts.length})`);
          await delay(1_500);
        } catch (err) {
          console.error(`  Page ${pageNum} error:`, err);
          break;
        }
      }
    }
  }

  // If no API products found, try scraping from DOM directly
  if (allProducts.length === 0) {
    console.log("\n[ALT] No API products found, trying DOM scrape...");
    const domProducts = await page.evaluate(() => {
      const cards = document.querySelectorAll('[data-testid="product-card"], .product-card, [class*="ProductCard"], [class*="product-card"]');
      console.log(`Found ${cards.length} product cards in DOM`);
      const results: any[] = [];

      // Also try to find product data in __NEXT_DATA__ or window.__DATA__
      const nextData = (window as any).__NEXT_DATA__;
      if (nextData?.props?.pageProps?.products) {
        return nextData.props.pageProps.products;
      }

      // Try window state
      const state = (window as any).__INITIAL_STATE__ ?? (window as any).__DATA__;
      if (state) {
        return [{ _state: JSON.stringify(state).substring(0, 2000) }];
      }

      // DOM scraping fallback
      cards.forEach((card) => {
        const nameEl = card.querySelector('[class*="name"], [class*="title"], h3, h4');
        const priceEl = card.querySelector('[class*="price"]');
        const imgEl = card.querySelector("img");
        const linkEl = card.querySelector("a");

        if (nameEl) {
          results.push({
            name: nameEl.textContent?.trim() ?? "",
            priceText: priceEl?.textContent?.trim() ?? "",
            image: imgEl?.src ?? "",
            link: linkEl?.href ?? "",
          });
        }
      });

      return results;
    });

    console.log(`  DOM found: ${domProducts.length} items`);
    if (domProducts.length > 0) {
      console.log(`  Sample:`, JSON.stringify(domProducts[0]).substring(0, 300));
    }
  }

  // Take screenshot for debugging
  await page.screenshot({ path: join(DATA_DIR, "debug-sale-page.png"), fullPage: false });
  console.log("  Screenshot saved.");

  // Clean up
  await page.close();
  browser.disconnect();
  chromeProcess.kill();

  // Save
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== Done! Saved ${sorted.length} products ===`);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
