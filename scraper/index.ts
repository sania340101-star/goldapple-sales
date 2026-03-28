import { chromium, type Page, type Browser } from "playwright";
import { mkdir, writeFile } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");

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
  scrapedAt: string;
}

const CATEGORIES = [
  { slug: "makijazh", name: "Макияж" },
  { slug: "uhod", name: "Уход за лицом" },
  { slug: "volosy", name: "Волосы" },
  { slug: "parfjumerija", name: "Парфюмерия" },
  { slug: "uhod-za-telom", name: "Уход за телом" },
  { slug: "nogti", name: "Ногти" },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return delay(ms);
}

function extractPrice(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[^\d.,]/g, "").replace(",", ".");
    return parseFloat(cleaned) || 0;
  }
  if (typeof value === "object" && value !== null) {
    const obj = value as Record<string, unknown>;
    return extractPrice(obj.amount ?? obj.value ?? obj.actual ?? 0);
  }
  return 0;
}

function extractImageUrl(item: Record<string, unknown>): string {
  const images = item.images as Array<Record<string, unknown>> | undefined;
  if (images?.[0]) {
    return String(images[0].url ?? images[0].src ?? "");
  }
  const image = item.image ?? item.imageUrl ?? item.img;
  if (typeof image === "string") return image;
  if (typeof image === "object" && image !== null) {
    return String((image as Record<string, unknown>).url ?? "");
  }
  return "";
}

function extractProductUrl(item: Record<string, unknown>, id: string): string {
  const url = item.url ?? item.link ?? item.productUrl;
  if (typeof url === "string") {
    return url.startsWith("http") ? url : `https://goldapple.by${url}`;
  }
  const slug = item.slug ?? item.code;
  if (typeof slug === "string") {
    return `https://goldapple.by/product/${slug}`;
  }
  return `https://goldapple.by/product/${id}`;
}

function extractProductsFromResponse(data: unknown, category: string): Product[] {
  const products: Product[] = [];
  const now = new Date().toISOString();

  try {
    const response = data as Record<string, unknown>;
    const items =
      ((response?.data as Record<string, unknown>)?.products as Array<Record<string, unknown>>) ??
      ((response as Record<string, unknown>)?.products as Array<Record<string, unknown>>) ??
      [];

    for (const item of items) {
      const price = extractPrice(item.price ?? item.currentPrice);
      const oldPrice = extractPrice(item.oldPrice ?? item.previousPrice ?? item.basePrice);

      if (oldPrice > price && price > 0) {
        const discount = Math.round(((oldPrice - price) / oldPrice) * 100);
        const id = String(item.id ?? item.itemId ?? item.sku ?? `${category}-${products.length}`);
        const name = String(item.name ?? item.title ?? "");
        const brand = String(
          item.brand?.toString() ?? (item.brandInfo as Record<string, unknown>)?.name ?? ""
        );
        const imageUrl = extractImageUrl(item);
        const productUrl = extractProductUrl(item, id);

        products.push({
          id,
          name,
          brand,
          price,
          oldPrice,
          discount,
          imageUrl,
          productUrl,
          category,
          scrapedAt: now,
        });
      }
    }
  } catch (err) {
    console.error(`  Error extracting products: ${err}`);
  }

  return products;
}

async function scrapeCategory(
  browser: Browser,
  categorySlug: string,
  categoryName: string
): Promise<Product[]> {
  const allProducts: Product[] = [];
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
  });
  const page = await context.newPage();

  const interceptedData: Array<Record<string, unknown>> = [];

  // Intercept API responses
  page.on("response", async (response) => {
    const url = response.url();
    if (
      url.includes("/api/catalog/products") ||
      url.includes("/api/catalogue/products") ||
      (url.includes("/front/api/") && url.includes("product"))
    ) {
      try {
        const json = await response.json();
        interceptedData.push(json);
      } catch {
        // Not JSON, skip
      }
    }
  });

  try {
    const url = `https://goldapple.by/catalogues/${categorySlug}`;
    console.log(`  Opening ${url}...`);
    await page.goto(url, { waitUntil: "networkidle", timeout: 60000 });
    await randomDelay(3000, 5000);

    // Try to close cookie/popup banners
    try {
      const closeBtn = page.locator('[class*="close"], [class*="dismiss"], [aria-label="Close"]').first();
      if (await closeBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
        await closeBtn.click();
        await delay(500);
      }
    } catch {
      // No popup
    }

    // Scroll down to trigger lazy loading
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await randomDelay(2000, 4000);
    }

    // Try "load more" buttons
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const loadMore = page.locator(
          'button:has-text("Показать ещё"), button:has-text("Показать еще"), [class*="load-more"], [class*="show-more"]'
        ).first();
        if (await loadMore.isVisible({ timeout: 2000 }).catch(() => false)) {
          await loadMore.click();
          await randomDelay(3000, 5000);
        } else {
          break;
        }
      } catch {
        break;
      }
    }

    // Process intercepted API data
    for (const data of interceptedData) {
      const products = extractProductsFromResponse(data, categoryName);
      allProducts.push(...products);
    }

    // If no API data intercepted, fall back to DOM scraping
    if (allProducts.length === 0) {
      console.log(`  No API data intercepted, trying DOM scraping...`);
      const domProducts = await scrapeDom(page, categoryName);
      allProducts.push(...domProducts);
    }

    console.log(`  Found ${allProducts.length} discounted products in ${categoryName}`);
  } catch (err) {
    console.error(`  Error scraping ${categoryName}: ${err}`);
  } finally {
    await context.close();
  }

  return allProducts;
}

async function scrapeDom(page: Page, category: string): Promise<Product[]> {
  const now = new Date().toISOString();

  return page.evaluate(
    ({ category, now }: { category: string; now: string }) => {
      const products: Array<{
        id: string;
        name: string;
        brand: string;
        price: number;
        oldPrice: number;
        discount: number;
        imageUrl: string;
        productUrl: string;
        category: string;
        scrapedAt: string;
      }> = [];

      const cardSelectors = [
        '[data-testid="product-card"]',
        '[class*="ProductCard"]',
        '[class*="product-card"]',
        '[class*="catalog-item"]',
        'article[class*="product"]',
        ".product-item",
      ];

      let cards: NodeListOf<Element> | null = null;
      for (const selector of cardSelectors) {
        cards = document.querySelectorAll(selector);
        if (cards.length > 0) break;
      }

      if (!cards || cards.length === 0) return products;

      cards.forEach((card, idx) => {
        try {
          const priceEls = card.querySelectorAll('[class*="price"], [class*="Price"]');
          let currentPrice = 0;
          let oldPrice = 0;

          priceEls.forEach((el) => {
            const text = el.textContent?.replace(/[^\d.,]/g, "").replace(",", ".") ?? "";
            const val = parseFloat(text);
            if (!val) return;

            const classList = el.className.toLowerCase();
            if (
              classList.includes("old") ||
              classList.includes("prev") ||
              classList.includes("crossed") ||
              (el as HTMLElement).style?.textDecoration === "line-through"
            ) {
              oldPrice = val;
            } else {
              if (currentPrice === 0) currentPrice = val;
            }
          });

          if (oldPrice > currentPrice && currentPrice > 0) {
            const nameEl = card.querySelector(
              '[class*="name"], [class*="Name"], [class*="title"], h3, h4'
            );
            const brandEl = card.querySelector('[class*="brand"], [class*="Brand"]');
            const imgEl = card.querySelector("img");
            const linkEl = card.querySelector("a[href]");

            const discount = Math.round(((oldPrice - currentPrice) / oldPrice) * 100);

            products.push({
              id: `dom-${category}-${idx}`,
              name: nameEl?.textContent?.trim() ?? "",
              brand: brandEl?.textContent?.trim() ?? "",
              price: currentPrice,
              oldPrice,
              discount,
              imageUrl: imgEl?.src ?? "",
              productUrl: linkEl?.getAttribute("href") ?? "",
              category,
              scrapedAt: now,
            });
          }
        } catch {
          // Skip problematic card
        }
      });

      return products;
    },
    { category, now }
  );
}

export async function runScraper(): Promise<Product[]> {
  console.log("Starting Золотое Яблоко scraper...");
  console.log(`Time: ${new Date().toLocaleString("ru-RU")}`);

  await mkdir(DATA_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
    ],
  });

  const allProducts: Product[] = [];
  const seenIds = new Set<string>();

  for (const cat of CATEGORIES) {
    console.log(`\nScraping category: ${cat.name} (${cat.slug})`);
    try {
      const products = await scrapeCategory(browser, cat.slug, cat.name);
      for (const p of products) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allProducts.push(p);
        }
      }
    } catch (err) {
      console.error(`Failed to scrape ${cat.name}: ${err}`);
    }
    await randomDelay(3000, 6000);
  }

  await browser.close();

  // Sort by discount descending
  allProducts.sort((a, b) => b.discount - a.discount);

  console.log(`\nTotal discounted products found: ${allProducts.length}`);
  console.log(`Saving to ${OUTPUT_FILE}...`);

  await writeFile(OUTPUT_FILE, JSON.stringify(allProducts, null, 2), "utf-8");
  console.log("Done!");

  return allProducts;
}

// Run directly
if (import.meta.main) {
  runScraper().catch(console.error);
}
