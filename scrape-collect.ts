import puppeteer from "puppeteer";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");
const SITE_URL = "https://goldapple.ru";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function parseProduct(item: any, now: string, category: string): Product | null {
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

async function fetchCategoryViaPage(
  page: any,
  categoryUrl: string,
  categoryName: string,
  allProducts: Product[],
  seenIds: Set<string>,
  now: string
): Promise<number> {
  let added = 0;

  // Navigate to the category page
  console.log(`\n  -> Navigating to: ${categoryName} (${categoryUrl})`);
  await page.goto(categoryUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await delay(3_000);

  // Close popups
  await page.evaluate(() => {
    document.querySelectorAll("button").forEach((btn: any) => {
      const t = btn.textContent?.trim()?.toLowerCase() ?? "";
      if (["да, верно", "хорошо", "ок", "принять", "закрыть"].some((x) => t.includes(x))) btn.click();
    });
  });
  await delay(1_000);

  // Try to discover the categoryId from the page
  const categoryId = await page.evaluate(() => {
    // Check __NEXT_DATA__
    const nd = (window as any).__NEXT_DATA__;
    if (nd?.props?.pageProps?.categoryId) return nd.props.pageProps.categoryId;
    if (nd?.props?.pageProps?.initialState?.catalog?.categoryId) return nd.props.pageProps.initialState.catalog.categoryId;

    // Check script tags
    const scripts = document.querySelectorAll("script");
    for (const s of scripts) {
      const t = s.textContent ?? "";
      const m = t.match(/"categoryId"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }

    // Check meta tags or data attributes
    const el = document.querySelector("[data-category-id]");
    if (el) return el.getAttribute("data-category-id");

    return null;
  });

  if (categoryId) {
    console.log(`  Found categoryId: ${categoryId}`);

    // Fetch all pages via browser context (avoids CORS/cookie issues)
    for (let pageNum = 0; pageNum < 100; pageNum++) {
      const apiUrl = `/front/api/catalog/products?categoryId=${categoryId}&cityId=0c5b2444-70a0-4932-980c-b4dc0d3f02b5&pageNumber=${pageNum}`;

      const result = await page.evaluate(async (url: string) => {
        try {
          const r = await fetch(url, { credentials: "include" });
          if (!r.ok) return { error: r.status };
          return await r.json();
        } catch (e: any) {
          return { error: e.message };
        }
      }, apiUrl);

      if (result?.error) {
        console.log(`  Page ${pageNum}: error ${result.error}`);
        break;
      }

      const items = result?.data?.products ?? result?.products ?? [];
      if (items.length === 0) {
        console.log(`  Page ${pageNum}: empty — done with ${categoryName}`);
        break;
      }

      for (const item of items) {
        const product = parseProduct(item, now, categoryName);
        if (product && !seenIds.has(product.id)) {
          seenIds.add(product.id);
          allProducts.push(product);
          added++;
        }
      }

      console.log(`  Page ${pageNum}: ${items.length} items, +${added} new (total: ${allProducts.length})`);
      await delay(1_200);
    }
  } else {
    console.log(`  No categoryId found, trying scroll + DOM scraping...`);

    // Scroll and collect from intercepted responses
    for (let i = 0; i < 30; i++) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await delay(2_000);

      // Click "show more" if available
      await page.evaluate(() => {
        document.querySelectorAll("button").forEach((btn: any) => {
          const t = btn.textContent?.trim()?.toLowerCase() ?? "";
          if (t.includes("показать ещё") || t.includes("загрузить ещё")) btn.click();
        });
      });
    }
  }

  return added;
}

async function main() {
  console.log("=== Gold Apple Collector ===\n");
  await mkdir(DATA_DIR, { recursive: true });

  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("goldapple.ru"));
  if (!page) {
    page = await browser.newPage();
  }

  console.log(`Connected to tab: ${page.url()}\n`);

  const allProducts: Product[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  // Set up response interceptor to catch any API responses
  page.on("response", async (response: any) => {
    const url = response.url();
    if (url.includes("/front/api/catalog/products") || url.includes("/web/api/")) {
      try {
        const json = await response.json();
        const items = json?.data?.products ?? json?.products ?? [];
        for (const item of items) {
          const product = parseProduct(item, now, "Sale");
          if (product && !seenIds.has(product.id)) {
            seenIds.add(product.id);
            allProducts.push(product);
          }
        }
      } catch {}
    }
  });

  // Sale category pages on goldapple.ru
  const saleCategories = [
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja`, name: "Все скидки" },
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja/dlja-detej`, name: "Для детей" },
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja/uhod`, name: "Уход" },
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja/makijazh`, name: "Макияж" },
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja/parfjumerija`, name: "Парфюмерия" },
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja/volosy`, name: "Волосы" },
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja/zdorovje`, name: "Здоровье" },
    { url: `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja/dom`, name: "Дом" },
  ];

  // First try to get categoryId from the currently open page
  console.log("[1] Checking current page for API data...");

  // Navigate to main sale page first
  await page.goto(saleCategories[0].url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await delay(5_000);

  // Close popups
  await page.evaluate(() => {
    document.querySelectorAll("button").forEach((btn: any) => {
      const t = btn.textContent?.trim()?.toLowerCase() ?? "";
      if (["да, верно", "хорошо", "ок", "принять", "закрыть"].some((x) => t.includes(x))) btn.click();
    });
  });
  await delay(2_000);

  // Try to find category links on the page
  const foundCategories = await page.evaluate(() => {
    const links: Array<{ href: string; text: string }> = [];
    document.querySelectorAll("a[href]").forEach((el) => {
      const href = (el as HTMLAnchorElement).href;
      const text = el.textContent?.trim()?.substring(0, 60) ?? "";
      if (href.includes("skidki-vyshli-iz-pod-kontrolja/") && text.length > 0 && text.length < 60) {
        if (!links.some((l) => l.href === href)) {
          links.push({ href, text });
        }
      }
    });
    return links;
  });

  console.log(`Found ${foundCategories.length} category links on sale page:`);
  for (const c of foundCategories) {
    console.log(`  ${c.text} -> ${c.href}`);
  }

  // Use discovered categories if available, otherwise use hardcoded list
  const categoriesToScrape =
    foundCategories.length > 3
      ? foundCategories.map((c) => ({ url: c.href, name: c.text }))
      : saleCategories;

  console.log(`\n[2] Scraping ${categoriesToScrape.length} categories...\n`);

  for (const cat of categoriesToScrape) {
    await fetchCategoryViaPage(page, cat.url, cat.name, allProducts, seenIds, now);
    console.log(`  === Total after "${cat.name}": ${allProducts.length} products ===`);
  }

  // If nothing from API, try DOM scraping as fallback
  if (allProducts.length === 0) {
    console.log("\n[3] API approach yielded 0 products. Trying DOM extraction...");

    for (const cat of categoriesToScrape.slice(0, 3)) {
      await page.goto(cat.url, { waitUntil: "networkidle2", timeout: 60_000 });
      await delay(3_000);

      // Scroll fully
      for (let i = 0; i < 50; i++) {
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await delay(1_500);
        await page.evaluate(() => {
          document.querySelectorAll("button").forEach((btn: any) => {
            const t = btn.textContent?.trim()?.toLowerCase() ?? "";
            if (t.includes("показать ещё") || t.includes("загрузить")) btn.click();
          });
        });

        // Check if we've reached the bottom
        const atBottom = await page.evaluate(() => {
          return window.scrollY + window.innerHeight >= document.body.scrollHeight - 100;
        });
        if (atBottom && i > 5) break;
      }

      // Extract from DOM
      const domProducts = await page.evaluate(() => {
        const results: any[] = [];
        // Look for product card elements
        const cards = document.querySelectorAll('[class*="product"], [class*="Product"], [data-testid*="product"]');

        for (const card of cards) {
          const linkEl = card.querySelector("a[href]") as HTMLAnchorElement | null;
          const url = linkEl?.href ?? "";
          if (!url.includes("goldapple.ru/")) continue;

          const name = card.querySelector('[class*="name"], [class*="Name"], [class*="title"]')?.textContent?.trim() ?? "";
          const brand = card.querySelector('[class*="brand"], [class*="Brand"]')?.textContent?.trim() ?? "";

          // Find prices
          const priceEls = card.querySelectorAll('[class*="rice"], [class*="Rice"]');
          const prices: number[] = [];
          for (const el of priceEls) {
            const text = el.textContent?.replace(/[^\d]/g, "") ?? "";
            const val = parseInt(text);
            if (val > 0 && val < 1_000_000) prices.push(val);
          }

          if (prices.length >= 2 || (name && url)) {
            results.push({
              url,
              name,
              brand,
              prices,
              html: card.innerHTML?.substring(0, 500),
            });
          }
        }

        return results;
      });

      console.log(`  DOM extraction from "${cat.name}": ${domProducts.length} items`);

      for (const dp of domProducts) {
        if (dp.prices.length >= 2) {
          const [price, oldPrice] = dp.prices[0] < dp.prices[1] ? [dp.prices[0], dp.prices[1]] : [dp.prices[1], dp.prices[0]];
          if (oldPrice > price) {
            const id = dp.url.split("/").pop() ?? `dom-${allProducts.length}`;
            if (!seenIds.has(id)) {
              seenIds.add(id);
              allProducts.push({
                id,
                name: dp.name,
                brand: dp.brand,
                price,
                oldPrice,
                discount: Math.round(((oldPrice - price) / oldPrice) * 100),
                imageUrl: "",
                productUrl: dp.url,
                category: cat.name,
                rating: 0,
                reviewsCount: 0,
                scrapedAt: now,
              });
            }
          }
        }
      }

      console.log(`  Total after DOM: ${allProducts.length}`);
    }
  }

  // Sort by discount and save
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== DONE! Saved ${sorted.length} products to ${OUTPUT_FILE} ===`);

  // Take screenshot
  try {
    await page.screenshot({ path: join(DATA_DIR, "collect-state.png") });
  } catch {}

  browser.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
