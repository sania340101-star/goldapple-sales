import puppeteer from "puppeteer";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");
const SITE_URL = "https://goldapple.ru";

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  console.log("=== Gold Apple DOM Scraper ===");
  await mkdir(DATA_DIR, { recursive: true });

  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("goldapple.ru"));

  if (!page) {
    console.error("No goldapple tab found!");
    browser.disconnect();
    return;
  }

  console.log(`Connected to: ${page.url()}`);
  console.log(`Title: ${await page.title()}`);

  // First, monitor network to find the real API endpoints
  const apiCalls: { url: string; status: number; body?: any }[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("goldapple.ru") && (url.includes("api") || url.includes("front"))) {
      const entry: any = { url: url.substring(0, 200), status: response.status() };
      try {
        if (response.headers()["content-type"]?.includes("json")) {
          entry.body = await response.json();
        }
      } catch {}
      apiCalls.push(entry);
    }
  });

  // Scroll through the entire page to load all products
  console.log("\n[1] Scrolling through page to load all products...");

  let lastHeight = 0;
  let sameHeightCount = 0;

  for (let i = 0; i < 100; i++) {
    const height = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(2_000);

    const newHeight = await page.evaluate(() => document.body.scrollHeight);
    console.log(`  Scroll ${i}: height ${newHeight}`);

    if (newHeight === lastHeight) {
      sameHeightCount++;
      if (sameHeightCount >= 3) {
        console.log("  No more content loading, stopping scroll.");
        break;
      }
    } else {
      sameHeightCount = 0;
    }
    lastHeight = newHeight;

    // Click "show more" button if exists
    try {
      await page.evaluate(() => {
        const buttons = document.querySelectorAll("button");
        for (const btn of buttons) {
          const text = btn.textContent?.toLowerCase() ?? "";
          if (text.includes("показать ещё") || text.includes("загрузить") || text.includes("show more")) {
            btn.click();
            return true;
          }
        }
        return false;
      });
    } catch {}
  }

  // Log API calls discovered
  console.log(`\n[2] Discovered ${apiCalls.length} API calls:`);
  for (const call of apiCalls.slice(0, 30)) {
    console.log(`  ${call.status} ${call.url}`);
    if (call.body?.data?.products) {
      console.log(`    -> ${call.body.data.products.length} products`);
    }
  }

  // Extract products from DOM
  console.log("\n[3] Extracting products from DOM...");

  const domData = await page.evaluate(() => {
    // Try to find product data in various page structures
    const results: any[] = [];

    // Method 1: Product cards with data attributes or specific class patterns
    const productCards = document.querySelectorAll(
      '[class*="product-card"], [class*="ProductCard"], [data-testid*="product"], [class*="catalog-item"], [class*="CatalogItem"]'
    );
    console.log(`Method 1: Found ${productCards.length} product cards`);

    // Method 2: Look for all link elements that look like product links
    const productLinks = document.querySelectorAll('a[href*="/productpage/"], a[href*="/product/"]');
    console.log(`Method 2: Found ${productLinks.length} product links`);

    // Method 3: Try __NEXT_DATA__ or similar
    const nextData = (document.getElementById("__NEXT_DATA__") as HTMLScriptElement)?.textContent;
    if (nextData) {
      try {
        const parsed = JSON.parse(nextData);
        const props = parsed?.props?.pageProps;
        if (props) {
          return { source: "__NEXT_DATA__", data: props };
        }
      } catch {}
    }

    // Method 4: Search all script tags for product data
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const text = script.textContent ?? "";
      if (text.includes('"products"') && text.includes('"price"') && text.length > 1000) {
        // Try to parse as JSON
        try {
          // Look for JSON objects in script content
          const jsonMatch = text.match(/\{[^{}]*"products"\s*:\s*\[[\s\S]*?\]\s*[^{}]*\}/);
          if (jsonMatch) {
            return { source: "script_tag", data: JSON.parse(jsonMatch[0]) };
          }
        } catch {}
      }
    }

    // Method 5: Extract from visible DOM elements
    // Look for price elements on the page
    const allElements = document.querySelectorAll("*");
    const pricePattern = /\d[\d\s]*₽/;
    const productElements: any[] = [];

    // Find all links that look like products
    for (const link of productLinks) {
      const card = link.closest("[class]") ?? link.parentElement;
      if (!card) continue;

      const name = card.querySelector('[class*="name"], [class*="title"], h3, h4, [class*="Name"]')?.textContent?.trim();
      const brand = card.querySelector('[class*="brand"], [class*="Brand"]')?.textContent?.trim();
      const imgEl = card.querySelector("img");
      const href = (link as HTMLAnchorElement).href;

      // Find prices in the card
      const priceTexts: string[] = [];
      card.querySelectorAll('[class*="price"], [class*="Price"], [class*="cost"], [class*="Cost"]').forEach((el) => {
        priceTexts.push(el.textContent?.trim() ?? "");
      });

      if (name || brand) {
        productElements.push({
          name: name ?? "",
          brand: brand ?? "",
          image: imgEl?.src ?? "",
          url: href,
          priceTexts,
          cardHTML: card.innerHTML.substring(0, 500),
        });
      }
    }

    if (productElements.length > 0) {
      return { source: "dom_links", count: productElements.length, items: productElements };
    }

    // Method 6: Get all visible text structure
    return {
      source: "fallback",
      bodyClasses: document.body.className,
      mainContent: document.querySelector("main")?.innerHTML?.substring(0, 3000) ?? "",
      productCardCount: productCards.length,
      productLinkCount: productLinks.length,
      scriptCount: scripts.length,
      firstLinks: Array.from(productLinks).slice(0, 5).map((l) => ({
        href: (l as HTMLAnchorElement).href,
        text: l.textContent?.trim()?.substring(0, 100),
      })),
    };
  });

  console.log(`\nDOM extraction result:`);
  console.log(JSON.stringify(domData, null, 2).substring(0, 3000));

  // If we got API products from interception, process them
  const allProducts: any[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  for (const call of apiCalls) {
    const items = call.body?.data?.products ?? call.body?.products ?? [];
    for (const item of items) {
      const price = item.price;
      if (!price) continue;

      const currentPrice = price.actual?.amount ?? price.current?.amount;
      const oldPrice = price.old?.amount ?? price.previous?.amount;
      if (!oldPrice || !currentPrice || oldPrice <= currentPrice) continue;

      const discount =
        price.viewOptions?.discountPercent ??
        Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
      if (discount < 1 || discount > 99) continue;

      const id = String(item.itemId ?? item.id ?? "");
      if (!id || seenIds.has(id)) continue;
      seenIds.add(id);

      const rawImgUrl = item.imageUrls?.[0]?.url ?? "";
      const imageUrl = rawImgUrl
        .replace("${screen}", "fullhd")
        .replace("${format}", "webp");

      allProducts.push({
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
      });
    }
  }

  console.log(`\n[4] API intercepted products: ${allProducts.length}`);

  // If we got DOM products, convert them too
  if (domData?.source === "dom_links" && domData.items) {
    console.log(`  DOM products: ${domData.items.length}`);
    // Save DOM data separately for analysis
    await writeFile(
      join(DATA_DIR, "dom-products-raw.json"),
      JSON.stringify(domData.items, null, 2),
      "utf-8"
    );
  }

  // Save all products
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== Done! Saved ${sorted.length} API products ===`);

  // Save full debug info
  await writeFile(
    join(DATA_DIR, "debug-api-calls.json"),
    JSON.stringify(apiCalls.map(c => ({ url: c.url, status: c.status, hasProducts: !!(c.body?.data?.products?.length) })), null, 2),
    "utf-8"
  );

  browser.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
