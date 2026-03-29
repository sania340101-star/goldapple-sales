import { chromium, type Browser, type BrowserContext, type Cookie } from "playwright";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");

const SITE_URL = "https://goldapple.ru";
const SALE_URL = `${SITE_URL}/sale`;
const API_BASE = `${SITE_URL}/front/api/catalog/products`;
const MOSCOW_CITY_ID = "0c5b2444-70a0-4932-980c-b4dc0d3f02b5";

const GIB_TIMEOUT_MS = 60_000;
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

interface ApiProductItem {
  itemId?: string;
  id?: string;
  name?: string;
  brand?: string;
  url?: string;
  price?: {
    actual?: { amount?: number };
    current?: { amount?: number };
    old?: { amount?: number };
    previous?: { amount?: number };
    viewOptions?: { discountPercent?: number };
  };
  imageUrls?: Array<{ url?: string }>;
  reviews?: {
    rating?: number;
    reviewsCount?: number;
  };
}

interface CatalogApiResponse {
  data?: {
    products?: ApiProductItem[];
    totalProducts?: number;
    totalPages?: number;
  };
  products?: ApiProductItem[];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHeaders(cookies: Cookie[]): Record<string, string> {
  const cookieString = cookies
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");

  return {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: SALE_URL,
    Origin: SITE_URL,
    Cookie: cookieString,
  };
}

function parseProduct(
  item: ApiProductItem,
  category: string,
  now: string,
): Product | null {
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
    category,
    rating: item.reviews?.rating ?? 0,
    reviewsCount: item.reviews?.reviewsCount ?? 0,
    scrapedAt: now,
  };
}

// ---------------------------------------------------------------------------
// Phase 1: Get GIB cookies via real browser
// ---------------------------------------------------------------------------

async function getGibCookies(): Promise<{
  cookies: Cookie[];
  categoryId: string | null;
}> {
  console.log("[Phase 1] Launching browser to solve GIB challenge...");

  const browser: Browser = await chromium.launch({
    headless: false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
      "--window-size=1920,1080",
    ],
    timeout: 60_000,
  });

  let categoryId: string | null = null;

  try {
    const context: BrowserContext = await browser.newContext({
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      viewport: { width: 1920, height: 1080 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      extraHTTPHeaders: {
        "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
    });

    // Stealth: override navigator properties
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      (window as any).chrome = { runtime: {} };
      Object.defineProperty(navigator, "plugins", {
        get: () => [1, 2, 3, 4, 5],
      });
      Object.defineProperty(navigator, "languages", {
        get: () => ["ru-RU", "ru", "en-US", "en"],
      });
    });

    // Pre-set cookie consent
    await context.addCookies([
      {
        name: "is-accepted-cookies",
        value: "true",
        domain: ".goldapple.ru",
        path: "/",
      },
    ]);

    const page = await context.newPage();

    // Listen for API catalog requests to discover categoryId
    page.on("request", (req) => {
      const url = req.url();
      if (url.includes("/front/api/catalog/products") && url.includes("categoryId=")) {
        const match = url.match(/categoryId=([^&]+)/);
        if (match && !categoryId) {
          categoryId = match[1];
          console.log(`  [Discovery] Found sale categoryId: ${categoryId}`);
        }
      }
    });

    // Navigate to sale page
    console.log("  Navigating to sale page...");
    await page.goto(SALE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 90_000,
    });

    // Wait for GIB challenge to complete
    console.log("  Waiting for GIB challenge to pass...");
    const startTime = Date.now();

    try {
      await page.waitForFunction(
        () => {
          const title = document.title.toLowerCase();
          // GIB challenge pages typically have "checking" or empty/generic titles
          const isChallenge =
            title.includes("checking") ||
            title.includes("ddos") ||
            title.includes("just a moment");
          // We also check for real page content
          const hasContent =
            document.querySelectorAll("a[href]").length > 10 ||
            document.querySelectorAll("img").length > 3;
          return !isChallenge && hasContent;
        },
        { timeout: GIB_TIMEOUT_MS },
      );
      console.log(
        `  GIB challenge passed in ${Date.now() - startTime}ms`,
      );
    } catch {
      console.error(
        `  GIB challenge FAILED after ${GIB_TIMEOUT_MS}ms`,
      );
      // Save debug screenshot
      try {
        await page.screenshot({
          path: join(DATA_DIR, "debug-gib-fail.png"),
          fullPage: true,
        });
        const content = await page.content();
        await writeFile(
          join(DATA_DIR, "debug-gib-fail.html"),
          content,
          "utf-8",
        );
        console.log("  Debug artifacts saved to data/");
      } catch (e) {
        console.error("  Failed to save debug artifacts:", e);
      }
      throw new Error("GIB challenge did not pass within timeout");
    }

    // Give the page a moment to make API calls so we can discover categoryId
    await delay(5_000);

    // Scroll a bit to trigger any lazy API calls
    await page.evaluate(() => window.scrollTo(0, 600));
    await delay(2_000);

    // Extract all cookies
    const cookies = await context.cookies();
    console.log(`  Extracted ${cookies.length} cookies`);

    await page.close();
    await context.close();

    return { cookies, categoryId };
  } finally {
    await browser.close();
    console.log("  Browser closed.");
  }
}

// ---------------------------------------------------------------------------
// Phase 2: Use cookies to call API directly
// ---------------------------------------------------------------------------

async function fetchCatalogPage(
  cookies: Cookie[],
  categoryId: string,
  pageNumber: number,
): Promise<{ items: ApiProductItem[]; totalProducts: number }> {
  const url = `${API_BASE}?categoryId=${categoryId}&cityId=${MOSCOW_CITY_ID}&pageNumber=${pageNumber}`;
  const headers = buildHeaders(cookies);

  const response = await fetch(url, { headers });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `API returned ${response.status} for page ${pageNumber}: ${text.slice(0, 200)}`,
    );
  }

  const json = (await response.json()) as CatalogApiResponse;
  const items = json?.data?.products ?? json?.products ?? [];
  const totalProducts = json?.data?.totalProducts ?? 0;

  return { items, totalProducts };
}

async function scrapeViaApi(
  cookies: Cookie[],
  categoryId: string,
): Promise<Product[]> {
  console.log(
    `[Phase 2] Fetching products via API (categoryId=${categoryId})...`,
  );

  const now = new Date().toISOString();
  const allProducts: Product[] = [];
  const seenIds = new Set<string>();
  let pageNumber = 0;
  let totalProducts = 0;

  while (pageNumber < MAX_PAGES) {
    console.log(`  Fetching page ${pageNumber}...`);

    try {
      const result = await fetchCatalogPage(cookies, categoryId, pageNumber);

      if (result.items.length === 0) {
        console.log(`  Page ${pageNumber}: empty, stopping pagination.`);
        break;
      }

      if (pageNumber === 0) {
        totalProducts = result.totalProducts;
        console.log(`  Total products reported by API: ${totalProducts}`);
      }

      let pageDiscounted = 0;
      for (const item of result.items) {
        const product = parseProduct(item, "Sale", now);
        if (product && !seenIds.has(product.id)) {
          seenIds.add(product.id);
          allProducts.push(product);
          pageDiscounted++;
        }
      }

      console.log(
        `  Page ${pageNumber}: ${result.items.length} items, ${pageDiscounted} discounted (total: ${allProducts.length})`,
      );

      pageNumber++;

      // Rate limit
      await delay(API_REQUEST_DELAY_MS);
    } catch (error) {
      console.error(`  Error fetching page ${pageNumber}:`, error);
      break;
    }
  }

  return allProducts;
}

// ---------------------------------------------------------------------------
// Phase 3: Save data
// ---------------------------------------------------------------------------

async function saveProducts(products: readonly Product[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  const sorted = [...products].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");

  console.log(
    `[Phase 3] Saved ${sorted.length} products to ${OUTPUT_FILE}`,
  );
}

// ---------------------------------------------------------------------------
// Known sale category IDs to try if discovery fails
// ---------------------------------------------------------------------------

const KNOWN_SALE_CATEGORY_IDS = [
  "cat570001", // sale category (common)
  "1000", // fallback
  "sale",
];

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function runScraper(): Promise<Product[]> {
  console.log("=== Gold Apple Sales Scraper (goldapple.ru) ===");
  console.log(`Time: ${new Date().toLocaleString("ru-RU")}`);

  await mkdir(DATA_DIR, { recursive: true });

  // Phase 1: Get cookies by solving GIB challenge
  const { cookies, categoryId: discoveredId } = await getGibCookies();

  if (cookies.length === 0) {
    console.error("FATAL: No cookies obtained from browser session.");
    await writeFile(OUTPUT_FILE, "[]", "utf-8");
    return [];
  }

  // Phase 2: Try discovered categoryId first, then fallbacks
  const idsToTry = discoveredId
    ? [discoveredId, ...KNOWN_SALE_CATEGORY_IDS]
    : KNOWN_SALE_CATEGORY_IDS;

  let products: Product[] = [];

  for (const catId of idsToTry) {
    console.log(`\nTrying categoryId: ${catId}`);
    try {
      products = await scrapeViaApi(cookies, catId);
      if (products.length > 0) {
        console.log(
          `Success with categoryId=${catId}: ${products.length} products`,
        );
        break;
      }
      console.log(`categoryId=${catId} returned 0 discounted products, trying next...`);
    } catch (error) {
      console.error(`categoryId=${catId} failed:`, error);
    }
  }

  if (products.length === 0) {
    console.warn(
      "WARNING: No products found with any categoryId. Saving empty array.",
    );
  }

  // Phase 3: Save
  await saveProducts(products);

  console.log(`\n=== Done. Total discounted products: ${products.length} ===`);
  return products;
}

if (import.meta.main) {
  runScraper().catch((err) => {
    console.error("Scraper failed:", err);
    process.exit(1);
  });
}
