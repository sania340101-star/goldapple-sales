import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

// Enable stealth mode to bypass bot detection (Group-IB / GIB)
chromium.use(StealthPlugin());

const DATA_DIR = join(import.meta.dir, "..", "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");
const SITE_URL = "https://goldapple.by";

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

function randomDelay(min: number, max: number): Promise<void> {
  return delay(Math.floor(Math.random() * (max - min + 1)) + min);
}

/** Wait until the page title no longer contains "checking" */
async function waitForDeviceCheck(page: any, timeout = 60000): Promise<boolean> {
  console.log("  Ожидание проверки устройства...");
  const start = Date.now();

  try {
    await page.waitForFunction(
      () => !document.title.toLowerCase().includes("checking"),
      { timeout },
    );
    console.log(`  Проверка пройдена за ${Date.now() - start}мс`);
    return true;
  } catch {
    console.log(`  Проверка НЕ пройдена за ${timeout}мс`);
    return false;
  }
}

/** Parse a product from API response item */
function parseApiProduct(
  item: any,
  category: string,
  now: string,
  seenIds: Set<string>,
): Product | null {
  const price = item?.price;
  if (!price) return null;

  const currentPrice = price.actual?.amount ?? price.current?.amount;
  const oldPrice = price.old?.amount ?? price.previous?.amount;
  if (!oldPrice || !currentPrice || oldPrice <= currentPrice) return null;

  const discount =
    price.viewOptions?.discountPercent ??
    Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
  if (discount < 1 || discount > 99) return null;

  const id = String(item.itemId ?? item.id ?? "");
  if (!id || seenIds.has(id)) return null;
  seenIds.add(id);

  const imageUrl =
    item.imageUrls?.[0]?.url
      ?.replace("${screen}", "fullhd")
      ?.replace("${format}", "webp") ?? "";

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

/** Extract products from DOM as fallback */
async function extractFromDOM(
  page: any,
  category: string,
  now: string,
): Promise<Product[]> {
  return page.evaluate(
    ({ category, now, siteUrl }: { category: string; now: string; siteUrl: string }) => {
      const products: any[] = [];

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
          break;
        }
      }

      if (cards.length === 0) {
        const links = document.querySelectorAll("a[href]");
        for (const link of links) {
          const href = link.getAttribute("href") ?? "";
          if (
            href.match(/\/(product|p|catalog)\/.+/i) &&
            link.querySelector("img")
          ) {
            cards.push(link);
          }
        }
      }

      for (const card of cards) {
        try {
          const link =
            card.closest("a") ?? card.querySelector("a") ?? card;
          const href = link.getAttribute("href") ?? "";

          const nameEl = card.querySelector(
            '[class*="name"], [class*="Name"], [class*="title"], [class*="Title"], h3, h4',
          );
          const name = nameEl?.textContent?.trim() ?? "";

          const brandEl = card.querySelector(
            '[class*="brand"], [class*="Brand"]',
          );
          const brand = brandEl?.textContent?.trim() ?? "";

          function parsePrice(text: string): number {
            const match = text.replace(/\s/g, "").match(/([\d.,]+)/);
            if (!match) return 0;
            return parseFloat(match[1].replace(",", "."));
          }

          const oldPriceEl = card.querySelector(
            '[class*="old"], [class*="Old"], [class*="cross"], [style*="line-through"], del, s',
          );
          const currentPriceEl = card.querySelector(
            '[class*="current"], [class*="Current"], [class*="actual"], [class*="sale"], [class*="Sale"]',
          );

          let oldPrice = oldPriceEl
            ? parsePrice(oldPriceEl.textContent ?? "")
            : 0;
          let currentPrice = currentPriceEl
            ? parsePrice(currentPriceEl.textContent ?? "")
            : 0;

          const priceEls = card.querySelectorAll(
            '[class*="price"], [class*="Price"]',
          );
          if ((!oldPrice || !currentPrice) && priceEls.length >= 2) {
            const prices = Array.from(priceEls)
              .map((el) => parsePrice(el.textContent ?? ""))
              .filter((p) => p > 0)
              .sort((a, b) => a - b);
            if (prices.length >= 2) {
              currentPrice = prices[0];
              oldPrice = prices[prices.length - 1];
            }
          }

          if (!oldPrice || !currentPrice || oldPrice <= currentPrice) continue;

          const discount = Math.round(
            ((oldPrice - currentPrice) / oldPrice) * 100,
          );
          if (discount < 1 || discount > 99) continue;

          const img = card.querySelector("img");
          const imageUrl =
            img?.getAttribute("src") ?? img?.getAttribute("data-src") ?? "";

          const ratingEl = card.querySelector('[class*="rating"]');
          const ratingMatch = (ratingEl?.textContent ?? "").match(/([\d.]+)/);
          const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;

          const productUrl = href.startsWith("http")
            ? href
            : `${siteUrl}${href}`;
          const id =
            href.replace(/[^a-zA-Z0-9]/g, "-").slice(0, 50) ||
            `prod-${products.length}`;

          products.push({
            id,
            name: name || "Без названия",
            brand,
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
        } catch {
          /* skip */
        }
      }

      return products;
    },
    { category, now, siteUrl: SITE_URL },
  );
}

async function scrapeCategory(
  context: any,
  categoryName: string,
  categoryPath: string,
  seenIds: Set<string>,
): Promise<Product[]> {
  const now = new Date().toISOString();
  const products: Product[] = [];
  const apiProducts: any[] = [];
  const page = await context.newPage();

  // Intercept all API responses with product data
  page.on("response", async (response: any) => {
    const url: string = response.url();
    if (url.includes("/api/") && response.status() === 200) {
      try {
        const json = await response.json();
        const items =
          json?.data?.products ??
          json?.products ??
          json?.data?.items ??
          [];
        if (Array.isArray(items) && items.length > 0) {
          console.log(
            `  [API] Перехвачено ${items.length} товаров от: ${url.substring(0, 120)}`,
          );
          apiProducts.push(...items);
        }
      } catch {
        /* not JSON */
      }
    }
  });

  console.log(`\nКатегория: ${categoryName} (${categoryPath})...`);

  try {
    await page.goto(`${SITE_URL}${categoryPath}`, {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });

    // Wait for device check
    const passed = await waitForDeviceCheck(page, 45000);
    if (!passed) {
      try {
        await page.screenshot({
          path: join(DATA_DIR, `debug-${categoryName}.png`),
        });
        console.log("  Скриншот сохранён для отладки");
      } catch {}
      await page.close();
      return [];
    }

    // Wait for content to fully render
    await delay(5000);

    const title = await page.title();
    console.log(`  Страница: "${title}"`);

    // Log what's on the page for debugging
    const pageInfo = await page.evaluate(() => {
      const allLinks = document.querySelectorAll("a[href]");
      const productLinks = Array.from(allLinks).filter((a) => {
        const href = a.getAttribute("href") ?? "";
        return href.includes("/product") || href.includes("/p/");
      });
      const imgs = document.querySelectorAll("img");
      const classes = new Set<string>();
      document.querySelectorAll("[class]").forEach((el: Element) => {
        (el as HTMLElement).className.split(/\s+/).forEach((c: string) => {
          if (
            c.toLowerCase().includes("product") ||
            c.toLowerCase().includes("card") ||
            c.toLowerCase().includes("price") ||
            c.toLowerCase().includes("catalog")
          ) {
            classes.add(c);
          }
        });
      });
      return {
        productLinks: productLinks.length,
        images: imgs.length,
        classes: Array.from(classes).slice(0, 30),
        bodyLength: document.body?.textContent?.length ?? 0,
      };
    });
    console.log(
      `  Найдено: ${pageInfo.productLinks} product links, ${pageInfo.images} images, body: ${pageInfo.bodyLength} chars`,
    );
    if (pageInfo.classes.length > 0) {
      console.log(`  Классы: ${pageInfo.classes.join(", ")}`);
    }

    // Scroll to trigger lazy loading
    for (let i = 0; i < 10; i++) {
      await page.evaluate(() =>
        window.scrollTo(0, document.body.scrollHeight),
      );
      await delay(2000);

      // Try "load more" button
      try {
        const btn = await page.$(
          'button:has-text("Показать ещё"), button:has-text("Загрузить ещё"), [class*="more"], [class*="load-more"], [class*="show-more"]',
        );
        if (btn && (await btn.isVisible())) {
          await btn.click();
          console.log(`  Нажата кнопка "Показать ещё" (scroll ${i + 1})`);
          await delay(3000);
        }
      } catch {
        /* no button */
      }
    }

    // Strategy 1: API data
    if (apiProducts.length > 0) {
      console.log(`  [API] Всего перехвачено: ${apiProducts.length}`);
      for (const item of apiProducts) {
        const product = parseApiProduct(item, categoryName, now, seenIds);
        if (product) products.push(product);
      }
    }

    // Strategy 2: DOM extraction (fallback)
    if (products.length === 0) {
      const domProducts = await extractFromDOM(page, categoryName, now);
      console.log(
        `  [DOM] Извлечено ${domProducts.length} товаров со скидкой`,
      );
      for (const p of domProducts) {
        if (!seenIds.has(p.id)) {
          seenIds.add(p.id);
          products.push(p);
        }
      }
    }

    console.log(`  Итого со скидкой в ${categoryName}: ${products.length}`);
  } catch (err) {
    console.error(`  Ошибка в ${categoryName}: ${err}`);
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
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    locale: "ru-BY",
    timezoneId: "Europe/Minsk",
    viewport: { width: 1920, height: 1080 },
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    extraHTTPHeaders: {
      "Accept-Language": "ru-BY,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    },
  });

  // Block heavy resources to speed up loading
  await context.route(/\.(woff2?|ttf|otf|mp4|webm)$/, (route: any) =>
    route.abort(),
  );

  // CRITICAL: Navigate to homepage first to establish session & pass device check
  console.log("\nОткрываю главную страницу для установки сессии...");
  const setupPage = await context.newPage();
  await setupPage.goto(SITE_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  const homePassed = await waitForDeviceCheck(setupPage, 60000);
  if (!homePassed) {
    console.log(
      "ОШИБКА: Не удалось пройти проверку устройства на главной странице",
    );
    try {
      await setupPage.screenshot({ path: join(DATA_DIR, "debug-home.png") });
    } catch {}
    await browser.close();

    // Save empty array so the site doesn't break
    await writeFile(OUTPUT_FILE, "[]", "utf-8");
    return [];
  }

  // Let cookies settle
  await delay(3000);
  await setupPage.close();

  const allProducts: Product[] = [];
  const seenIds = new Set<string>();

  try {
    for (const cat of CATEGORIES) {
      const products = await scrapeCategory(
        context,
        cat.name,
        cat.path,
        seenIds,
      );
      allProducts.push(...products);

      // Save incrementally after each category
      const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
      await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
      console.log(`  Всего сохранено: ${allProducts.length} товаров`);

      await randomDelay(3000, 5000);
    }
  } finally {
    await browser.close();
  }

  // Final sort & save
  allProducts.sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(allProducts, null, 2), "utf-8");

  console.log(`\n=== Итого товаров со скидками: ${allProducts.length} ===`);
  console.log("Готово!");

  return allProducts;
}

if (import.meta.main) {
  runScraper().catch(console.error);
}
