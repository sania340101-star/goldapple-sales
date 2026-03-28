import { mkdir, writeFile } from "fs/promises";
import { join } from "path";
import { chromium, type Page, type BrowserContext } from "playwright";

const DATA_DIR = join(import.meta.dir, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");

const SITE_URL = "https://goldapple.by";

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
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs: number, maxMs: number): Promise<void> {
  const ms = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return delay(ms);
}

/** Try to extract products from __NEXT_DATA__ or similar embedded JSON */
async function extractEmbeddedData(page: Page): Promise<any[]> {
  return page.evaluate(() => {
    // Try __NEXT_DATA__
    const nextData = (window as any).__NEXT_DATA__;
    if (nextData?.props?.pageProps?.products) {
      return nextData.props.pageProps.products;
    }
    if (nextData?.props?.pageProps?.initialData?.products) {
      return nextData.props.pageProps.initialData.products;
    }

    // Try script[type="application/json"] or script[id containing "data"]
    const scripts = document.querySelectorAll('script[type="application/json"], script[id*="data"], script[id*="state"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent ?? "");
        // Look for products array in any shape
        if (Array.isArray(data?.products)) return data.products;
        if (data?.data?.products) return data.data.products;
        if (data?.pageProps?.products) return data.pageProps.products;
      } catch { /* skip */ }
    }

    // Try window.__INITIAL_STATE__ or similar
    for (const key of Object.keys(window)) {
      if (key.startsWith("__") && key.includes("STATE") || key.includes("DATA") || key.includes("APOLLO")) {
        try {
          const val = (window as any)[key];
          if (val?.products) return val.products;
          if (val?.data?.products) return val.data.products;
        } catch { /* skip */ }
      }
    }

    return [];
  });
}

/** Extract product data from DOM elements */
async function extractFromDOM(page: Page, category: string, now: string): Promise<Product[]> {
  return page.evaluate(({ category, now, siteUrl }) => {
    const products: any[] = [];

    // Common selectors for product cards
    const selectors = [
      '[data-test="product-card"]',
      '[class*="product-card"]',
      '[class*="ProductCard"]',
      '[class*="catalog-card"]',
      '[class*="CatalogCard"]',
      'a[href*="/product/"]',
      'a[href*="/p/"]',
      '[itemtype="http://schema.org/Product"]',
      '[class*="item-card"]',
      '[class*="goods-card"]',
    ];

    let cards: Element[] = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      if (found.length > 0) {
        cards = Array.from(found);
        console.log(`Found ${cards.length} cards with selector: ${sel}`);
        break;
      }
    }

    if (cards.length === 0) {
      // Fallback: find all links that look like product links
      const links = document.querySelectorAll('a[href]');
      for (const link of links) {
        const href = link.getAttribute("href") ?? "";
        if (href.match(/\/(product|p|catalog)\/.+/i) && link.querySelector("img")) {
          cards.push(link);
        }
      }
    }

    for (const card of cards) {
      try {
        const link = card.closest("a") ?? card.querySelector("a") ?? card;
        const href = link.getAttribute("href") ?? "";

        // Get name
        const nameEl = card.querySelector('[class*="name"], [class*="Name"], [class*="title"], [class*="Title"], h3, h4, [data-test="product-name"]');
        const name = nameEl?.textContent?.trim() ?? "";

        // Get brand
        const brandEl = card.querySelector('[class*="brand"], [class*="Brand"], [data-test="product-brand"]');
        const brand = brandEl?.textContent?.trim() ?? "";

        // Get prices - look for crossed-out (old) price and current price
        const priceTexts: string[] = [];
        const priceEls = card.querySelectorAll('[class*="price"], [class*="Price"], [class*="cost"], [class*="Cost"]');
        for (const el of priceEls) {
          const text = el.textContent?.trim();
          if (text) priceTexts.push(text);
        }

        // Parse price values from text
        function parsePrice(text: string): number {
          const match = text.replace(/\s/g, "").match(/([\d.,]+)/);
          if (!match) return 0;
          return parseFloat(match[1].replace(",", "."));
        }

        // Try to find old price (with line-through or specific class)
        const oldPriceEl = card.querySelector('[class*="old"], [class*="Old"], [class*="cross"], [class*="Cross"], [style*="line-through"], del, s');
        const currentPriceEl = card.querySelector('[class*="current"], [class*="Current"], [class*="actual"], [class*="Actual"], [class*="sale"], [class*="Sale"]');

        let oldPrice = oldPriceEl ? parsePrice(oldPriceEl.textContent ?? "") : 0;
        let currentPrice = currentPriceEl ? parsePrice(currentPriceEl.textContent ?? "") : 0;

        // If we couldn't find specific price elements, try to parse from generic price elements
        if ((!oldPrice || !currentPrice) && priceTexts.length >= 2) {
          const prices = priceTexts.map(parsePrice).filter(p => p > 0).sort((a, b) => a - b);
          if (prices.length >= 2) {
            currentPrice = prices[0];
            oldPrice = prices[prices.length - 1];
          }
        }

        // Skip if no discount
        if (!oldPrice || !currentPrice || oldPrice <= currentPrice) continue;

        const discount = Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
        if (discount < 1 || discount > 99) continue;

        // Get image
        const img = card.querySelector("img");
        const imageUrl = img?.getAttribute("src") ?? img?.getAttribute("data-src") ?? "";

        // Get rating
        const ratingEl = card.querySelector('[class*="rating"], [class*="Rating"]');
        const ratingText = ratingEl?.textContent?.trim() ?? "";
        const ratingMatch = ratingText.match(/([\d.]+)/);
        const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

        const productUrl = href.startsWith("http") ? href : `${siteUrl}${href}`;
        const id = href.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 50) || `prod-${products.length}`;

        products.push({
          id,
          name: name || "Без названия",
          brand,
          productType: "",
          price: currentPrice,
          oldPrice,
          discount,
          imageUrl,
          productUrl,
          category,
          rating,
          reviewsCount: 0,
          scrapedAt: now,
        });
      } catch { /* skip individual card errors */ }
    }

    return products;
  }, { category, now, siteUrl: SITE_URL });
}

async function scrapeCategory(
  context: BrowserContext,
  categoryName: string,
  categoryPath: string,
  seenIds: Set<string>,
): Promise<Product[]> {
  const now = new Date().toISOString();
  const allProducts: Product[] = [];
  const page = await context.newPage();

  // Log all API responses for debugging
  const interceptedApiProducts: any[] = [];
  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/api/") && url.includes("product") && response.status() === 200) {
      try {
        const json = await response.json();
        const items = json?.data?.products ?? json?.products ?? [];
        if (items.length > 0) {
          console.log(`  [API] Intercepted ${items.length} products from: ${url.substring(0, 120)}`);
          interceptedApiProducts.push(...items);
        }
      } catch { /* not JSON */ }
    }
  });

  console.log(`\nСкрапинг категории: ${categoryName} (${categoryPath})...`);

  try {
    await page.goto(`${SITE_URL}${categoryPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for page to fully load
    await delay(5000);

    // Debug: log page title and URL
    const title = await page.title();
    const currentUrl = page.url();
    console.log(`  Страница: "${title}" URL: ${currentUrl}`);

    // Debug: check what's on the page
    const pageInfo = await page.evaluate(() => {
      const allLinks = document.querySelectorAll("a[href]");
      const productLinks = Array.from(allLinks).filter(a => {
        const href = a.getAttribute("href") ?? "";
        return href.includes("/product") || href.includes("/p/");
      });
      const imgs = document.querySelectorAll("img");
      const allClassNames = new Set<string>();
      document.querySelectorAll("[class]").forEach(el => {
        el.className.split(/\s+/).forEach(c => {
          if (c.toLowerCase().includes("product") || c.toLowerCase().includes("card") || c.toLowerCase().includes("price") || c.toLowerCase().includes("catalog")) {
            allClassNames.add(c);
          }
        });
      });
      return {
        productLinksCount: productLinks.length,
        imgCount: imgs.length,
        relevantClasses: Array.from(allClassNames).slice(0, 30),
        bodyTextLength: document.body?.textContent?.length ?? 0,
      };
    });
    console.log(`  Найдено: ${pageInfo.productLinksCount} product links, ${pageInfo.imgCount} images`);
    console.log(`  Relevant classes: ${pageInfo.relevantClasses.join(", ")}`);

    // Try scrolling to load more products
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(2000);

      // Try clicking "show more" or pagination
      try {
        const btn = await page.$('button:has-text("Показать ещё"), button:has-text("Загрузить ещё"), [class*="more"], [class*="load-more"], [class*="show-more"]');
        if (btn && await btn.isVisible()) {
          await btn.click();
          console.log(`  Нажата кнопка "Показать ещё" (scroll ${i + 1})`);
          await delay(3000);
        }
      } catch { /* no button */ }
    }

    // Strategy 1: Try intercepted API data
    if (interceptedApiProducts.length > 0) {
      console.log(`  [API] Всего перехвачено: ${interceptedApiProducts.length}`);
      for (const item of interceptedApiProducts) {
        const price = item?.price;
        if (!price) continue;
        const currentPrice = price.actual?.amount;
        const oldPrice = price.old?.amount;
        if (!oldPrice || !currentPrice || oldPrice <= currentPrice) continue;

        const discount = price.viewOptions?.discountPercent
          ?? Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
        if (discount < 1) continue;

        const id = item.itemId ?? item.id ?? "";
        if (seenIds.has(id)) continue;
        seenIds.add(id);

        const imageUrl = item.imageUrls?.[0]?.url
          ?.replace("${screen}", "fullhd")
          ?.replace("${format}", "webp") ?? "";

        allProducts.push({
          id,
          name: item.name ?? "",
          brand: item.brand ?? "",
          productType: item.productType ?? "",
          price: currentPrice,
          oldPrice,
          discount,
          imageUrl,
          productUrl: item.url ? `${SITE_URL}${item.url}` : "",
          category: categoryName,
          rating: item.reviews?.rating ?? 0,
          reviewsCount: item.reviews?.reviewsCount ?? 0,
          scrapedAt: now,
        });
      }
    }

    // Strategy 2: Try embedded JSON data
    if (allProducts.length === 0) {
      const embedded = await extractEmbeddedData(page);
      if (embedded.length > 0) {
        console.log(`  [Embedded] Найдено ${embedded.length} товаров`);
        for (const item of embedded) {
          const price = item?.price;
          if (!price) continue;
          const currentPrice = price.actual?.amount ?? item.price;
          const oldPrice = price.old?.amount ?? item.oldPrice;
          if (!oldPrice || !currentPrice || oldPrice <= currentPrice) continue;

          const discount = Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
          if (discount < 1) continue;

          const id = item.itemId ?? item.id ?? "";
          if (seenIds.has(id)) continue;
          seenIds.add(id);

          allProducts.push({
            id,
            name: item.name ?? "",
            brand: item.brand ?? "",
            productType: item.productType ?? "",
            price: currentPrice,
            oldPrice,
            discount,
            imageUrl: item.imageUrls?.[0]?.url ?? item.imageUrl ?? "",
            productUrl: item.url ? `${SITE_URL}${item.url}` : "",
            category: categoryName,
            rating: item.reviews?.rating ?? 0,
            reviewsCount: item.reviews?.reviewsCount ?? 0,
            scrapedAt: now,
          });
        }
      }
    }

    // Strategy 3: DOM extraction as fallback
    if (allProducts.length === 0) {
      const domProducts = await extractFromDOM(page, categoryName, now);
      console.log(`  [DOM] Извлечено ${domProducts.length} товаров со скидкой`);
      for (const p of domProducts) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          allProducts.push(p);
        }
      }
    }

    console.log(`  Итого со скидкой в ${categoryName}: ${allProducts.length}`);
  } catch (err) {
    console.error(`  Ошибка в категории ${categoryName}: ${err}`);
  } finally {
    await page.close();
  }

  return allProducts;
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

  // Block unnecessary resources to speed up
  await context.route(/\.(woff2?|ttf|otf|mp4|webm)$/, (route) => route.abort());

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
