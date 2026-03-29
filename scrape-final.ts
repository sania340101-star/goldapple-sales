import puppeteer, { type HTTPResponse } from "puppeteer";
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

async function main() {
  console.log("=== Gold Apple Final Scraper ===");
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

  console.log(`Using tab: ${page.url()}`);

  // Close popups first
  console.log("[1] Closing popups...");
  await page.evaluate(() => {
    // Close city popup
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const text = btn.textContent?.trim()?.toLowerCase() ?? "";
      if (text === "да, верно" || text === "хорошо" || text === "ок" || text === "принять") {
        btn.click();
      }
    }
  });
  await delay(1_000);
  await page.evaluate(() => {
    const buttons = document.querySelectorAll("button");
    for (const btn of buttons) {
      const text = btn.textContent?.trim()?.toLowerCase() ?? "";
      if (text === "хорошо" || text === "ок" || text === "принять" || text === "закрыть") {
        btn.click();
      }
    }
  });
  await delay(1_000);

  // Set up API interception
  const allProducts: Product[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();
  const apiEndpoints = new Set<string>();

  const handleResponse = async (response: HTTPResponse) => {
    const url = response.url();
    if (url.includes("catalog/products") || url.includes("plp") || url.includes("listing")) {
      console.log(`  [API] ${response.status()} ${url.substring(0, 150)}`);
      apiEndpoints.add(url.split("?")[0]);
      try {
        const json = await response.json();
        const items = json?.data?.products ?? json?.products ?? json?.data?.items ?? [];
        for (const item of items) {
          const product = parseProduct(item, now);
          if (product && !seenIds.has(product.id)) {
            seenIds.add(product.id);
            allProducts.push(product);
          }
        }
        if (items.length > 0) {
          console.log(`    -> ${items.length} items, total: ${allProducts.length}`);
        }
      } catch {}
    }
  };

  page.on("response", handleResponse);

  // Navigate to sale page
  console.log("[2] Navigating to sale catalog...");

  // First, find the real sale catalog URL
  const saleLinks = await page.evaluate(() => {
    const links = document.querySelectorAll("a[href]");
    const saleUrls: string[] = [];
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      if (href.includes("sale") || href.includes("skidki") || href.includes("rasprodazha") || href.includes("akci")) {
        saleUrls.push(href);
      }
    }
    return [...new Set(saleUrls)];
  });

  console.log(`  Found sale links: ${saleLinks.length}`);
  for (const link of saleLinks.slice(0, 10)) {
    console.log(`    ${link}`);
  }

  // Navigate to the sale/catalog page
  // Try goldapple.ru/catalogsale or similar URLs
  const saleUrls = [
    `${SITE_URL}/sale`,
    `${SITE_URL}/catalogsale`,
    `${SITE_URL}/skidki`,
    `${SITE_URL}/aktsii`,
    ...saleLinks.filter(l => l.includes("sale") || l.includes("skidki")),
  ];

  // First check what catalog categories have sales
  // Let's navigate to the main sale page we know works
  console.log("[3] Going to sale page and scrolling...");
  await page.goto(`${SITE_URL}/skidki-vyshli-iz-pod-kontrolja`, {
    waitUntil: "networkidle2",
    timeout: 60_000,
  });
  await delay(3_000);

  // Close popups again
  await page.evaluate(() => {
    document.querySelectorAll("button").forEach((btn) => {
      const text = btn.textContent?.trim()?.toLowerCase() ?? "";
      if (text === "да, верно" || text === "хорошо") btn.click();
    });
  });
  await delay(1_000);

  // Now let's find all category links on this page
  const categoryLinks = await page.evaluate(() => {
    const links = document.querySelectorAll("a[href]");
    const urls: Array<{ href: string; text: string }> = [];
    for (const link of links) {
      const href = (link as HTMLAnchorElement).href;
      const text = link.textContent?.trim()?.substring(0, 80) ?? "";
      if (href.includes("/catalogsale/") || href.includes("/sale/") || href.includes("categoryId")) {
        urls.push({ href, text });
      }
    }
    return urls;
  });

  console.log(`\n[4] Category links found: ${categoryLinks.length}`);
  for (const link of categoryLinks) {
    console.log(`  ${link.text} -> ${link.href}`);
  }

  // Scroll page to trigger infinite scroll and load products
  console.log("\n[5] Scrolling to load products...");
  let previousCount = allProducts.length;

  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2_000);

    // Try clicking "load more" buttons
    const clicked = await page.evaluate(() => {
      const btns = document.querySelectorAll("button, a");
      for (const btn of btns) {
        const text = btn.textContent?.trim()?.toLowerCase() ?? "";
        if (text.includes("показать ещё") || text.includes("загрузить ещё") || text.includes("ещё товары")) {
          (btn as HTMLElement).click();
          return text;
        }
      }
      return null;
    });

    if (clicked) {
      console.log(`  Clicked: "${clicked}"`);
      await delay(3_000);
    }

    if (i % 5 === 0) {
      console.log(`  Scroll ${i}: ${allProducts.length} products collected`);
    }

    // Check if we stopped getting new products
    if (i > 10 && allProducts.length === previousCount && !clicked) {
      console.log("  No new products for a while, trying categories...");
      break;
    }
    if (i % 5 === 0) previousCount = allProducts.length;
  }

  console.log(`\n[6] After scrolling: ${allProducts.length} products from API interception`);
  console.log(`  API endpoints discovered: ${[...apiEndpoints].join(", ")}`);

  // If we didn't get enough products from API, try DOM scraping
  if (allProducts.length < 10) {
    console.log("\n[7] Trying DOM scraping...");

    const domProducts = await page.evaluate(() => {
      const products: any[] = [];

      // Find all elements that look like product cards
      // Look for elements with price information
      const allPriceElements = document.querySelectorAll('[class*="rice"]');
      console.log(`Price elements: ${allPriceElements.length}`);

      // Get body HTML structure for debugging
      const bodyHTML = document.body.innerHTML;

      // Find product-like structures using various selectors
      const selectors = [
        '[class*="product"]',
        '[class*="Product"]',
        '[class*="card"]',
        '[class*="Card"]',
        '[class*="item"]',
        '[class*="Item"]',
        '[itemtype*="Product"]',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        if (elements.length > 0 && elements.length < 1000) {
          console.log(`${selector}: ${elements.length} elements`);
        }
      }

      // Try to find product links with prices
      const links = document.querySelectorAll("a[href]");
      for (const link of links) {
        const href = (link as HTMLAnchorElement).href;
        if (!href.includes("goldapple.ru/") || href.includes("/catalogsale") || href.includes("/sale")) continue;

        const el = link as HTMLElement;
        const text = el.textContent ?? "";

        // Check if this link contains price-like text (number followed by ₽)
        if (text.match(/\d[\d\s]*₽/)) {
          const parent = el.closest("[class]") ?? el.parentElement;
          if (!parent) continue;

          // Extract prices
          const priceMatch = text.match(/от\s*(\d[\d\s]*)\s*₽/);
          const oldPriceMatch = text.match(/от\s*(\d[\d\s]*)\s*₽.*?(\d[\d\s]*)\s*₽/);

          products.push({
            url: href,
            text: text.substring(0, 300),
            priceMatch: priceMatch?.[1],
          });
        }
      }

      return { products, bodyLength: bodyHTML.length };
    });

    console.log(`  DOM products found: ${domProducts.products.length}`);
    if (domProducts.products.length > 0) {
      console.log(`  Sample: ${JSON.stringify(domProducts.products[0]).substring(0, 300)}`);
    }

    // Save raw DOM data
    await writeFile(
      join(DATA_DIR, "dom-raw.json"),
      JSON.stringify(domProducts, null, 2),
      "utf-8"
    );
  }

  // If we have category links, try navigating to each and collecting products
  if (allProducts.length < 50 && categoryLinks.length > 0) {
    console.log("\n[8] Navigating category links to collect more products...");

    for (const link of categoryLinks.slice(0, 10)) {
      console.log(`  -> ${link.text}: ${link.href}`);
      try {
        await page.goto(link.href, { waitUntil: "networkidle2", timeout: 30_000 });
        await delay(3_000);

        // Scroll this category page
        for (let i = 0; i < 20; i++) {
          await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
          await delay(2_000);

          const clicked = await page.evaluate(() => {
            const btns = document.querySelectorAll("button");
            for (const btn of btns) {
              const text = btn.textContent?.trim()?.toLowerCase() ?? "";
              if (text.includes("показать ещё") || text.includes("загрузить ещё")) {
                btn.click();
                return true;
              }
            }
            return false;
          });

          if (!clicked) {
            const height = await page.evaluate(() => document.body.scrollHeight);
            const scroll = await page.evaluate(() => window.scrollY + window.innerHeight);
            if (scroll >= height - 100) break;
          }
        }

        console.log(`    Products so far: ${allProducts.length}`);
      } catch (err) {
        console.log(`    Error: ${err}`);
      }
    }
  }

  // Final save
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== DONE! Saved ${sorted.length} products to ${OUTPUT_FILE} ===`);

  // Screenshot
  try {
    await page.screenshot({ path: join(DATA_DIR, "final-state.png") });
  } catch {}

  page.removeListener("response", handleResponse);
  browser.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
