import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { chromium, type Page, type BrowserContext } from "playwright";

const DATA_DIR = join(import.meta.dir, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");

const SITE_URL = "https://goldapple.by";
const CATALOG_API_PATTERN = /\/front\/api\/catalog\/products/;

interface Product {
  id: string;
  name: string;
  brand: string;
  productType: string;
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

const CATEGORIES: ReadonlyArray<{ name: string; path: string }> = [
  { name: "Макияж", path: "/makijazh" },
  { name: "Уход за лицом", path: "/uhod" },
  { name: "Уход за телом", path: "/uhod-za-telom" },
  { name: "Волосы", path: "/volosy" },
  { name: "Парфюмерия", path: "/parfjumerija" },
  { name: "Ногти", path: "/nogti" },
  { name: "Красота", path: "/krasota" },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return delay(ms);
}

function buildImageUrl(imageUrls: any[]): string {
  if (!imageUrls?.length) return "";
  const img = imageUrls[0];
  if (!img?.url) return "";
  return img.url
    .replace("${screen}", "fullhd")
    .replace("${format}", "webp");
}

function parseProduct(item: any, category: string, now: string): Product | null {
  const price = item?.price;
  if (!price) return null;

  const currentPrice = price.actual?.amount;
  const oldPrice = price.old?.amount ?? price.regular?.amount;

  if (!oldPrice || !currentPrice || oldPrice <= currentPrice || currentPrice <= 0) return null;

  const discount = price.viewOptions?.discountPercent
    ?? Math.round(((oldPrice - currentPrice) / oldPrice) * 100);

  if (discount < 1) return null;

  return {
    id: item.itemId ?? item.id ?? "",
    name: item.name ?? "",
    brand: item.brand ?? "",
    productType: item.productType ?? "",
    price: currentPrice,
    oldPrice,
    discount,
    imageUrl: buildImageUrl(item.imageUrls),
    productUrl: item.url ? `${SITE_URL}${item.url}` : "",
    category,
    rating: item.reviews?.rating ?? 0,
    reviewsCount: item.reviews?.reviewsCount ?? 0,
    scrapedAt: now,
  };
}

async function scrapeCategory(
  context: BrowserContext,
  categoryName: string,
  categoryPath: string,
  seenIds: Set<string>,
): Promise<Product[]> {
  const now = new Date().toISOString();
  const products: Product[] = [];
  const page = await context.newPage();

  const interceptedProducts: any[] = [];

  // Intercept API responses
  page.on("response", async (response) => {
    const url = response.url();
    if (CATALOG_API_PATTERN.test(url) && response.status() === 200) {
      try {
        const json = await response.json();
        const items = json?.data?.products ?? json?.products ?? [];
        interceptedProducts.push(...items);
      } catch {
        // ignore parse errors
      }
    }
  });

  console.log(`\nСкрапинг категории: ${categoryName} (${categoryPath})...`);

  try {
    // Navigate to category page
    await page.goto(`${SITE_URL}${categoryPath}`, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    // Wait for products to load
    await delay(3000);

    // Try to scroll down to trigger more loads
    const maxScrolls = 15;
    for (let i = 0; i < maxScrolls; i++) {
      const prevCount = interceptedProducts.length;

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(1500);

      // Try clicking "show more" button if exists
      try {
        const showMoreBtn = await page.$('button:has-text("Показать ещё"), button:has-text("показать ещё"), [class*="more"], [class*="More"]');
        if (showMoreBtn) {
          await showMoreBtn.click();
          await delay(2000);
        }
      } catch {
        // no button found
      }

      // Check if new products were loaded
      if (interceptedProducts.length === prevCount && i > 2) {
        console.log(`  Прокрутка ${i + 1}: нет новых товаров, стоп`);
        break;
      }

      if (interceptedProducts.length > prevCount) {
        console.log(`  Прокрутка ${i + 1}: перехвачено ${interceptedProducts.length} товаров`);
      }
    }

    // Parse intercepted products
    for (const item of interceptedProducts) {
      const product = parseProduct(item, categoryName, now);
      if (product && !seenIds.has(product.id)) {
        seenIds.add(product.id);
        products.push(product);
      }
    }

    console.log(`  Итого со скидкой в ${categoryName}: ${products.length}`);
  } catch (err) {
    console.error(`  Ошибка в категории ${categoryName}: ${err}`);
  } finally {
    await page.close();
  }

  return products;
}

export async function runScraper(): Promise<Product[]> {
  console.log("=== Парсер скидок Золотого Яблока (goldapple.by) ===");
  console.log(`Время: ${new Date().toLocaleString("ru-RU")}`);

  await mkdir(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    locale: "ru-BY",
    timezoneId: "Europe/Minsk",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    extraHTTPHeaders: {
      "Accept-Language": "ru-BY,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  const allProducts: Product[] = [];
  const seenIds = new Set<string>();

  try {
    for (const cat of CATEGORIES) {
      const products = await scrapeCategory(context, cat.name, cat.path, seenIds);
      allProducts.push(...products);
      await randomDelay(3000, 5000);
    }
  } finally {
    await browser.close();
  }

  // Sort by discount descending
  allProducts.sort((a, b) => b.discount - a.discount);

  console.log(`\n=== Итого товаров со скидками: ${allProducts.length} ===`);
  console.log(`Сохранение в ${OUTPUT_FILE}...`);

  await writeFile(OUTPUT_FILE, JSON.stringify(allProducts, null, 2), "utf-8");
  console.log("Готово!");

  return allProducts;
}

if (import.meta.main) {
  runScraper().catch(console.error);
}
