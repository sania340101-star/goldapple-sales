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
  console.log("=== Gold Apple Scraper (Live Chrome CDP) ===");
  await mkdir(DATA_DIR, { recursive: true });

  // Connect to running Chrome
  console.log("[1] Connecting to Chrome via CDP...");
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  // Find the sale page tab or create one
  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("goldapple.ru"));

  if (!page) {
    console.log("  No goldapple tab found, opening new one...");
    page = await browser.newPage();
    await page.goto(SALE_URL, { waitUntil: "domcontentloaded", timeout: 120_000 });
  } else {
    console.log(`  Found existing tab: ${page.url()}`);
  }

  // Wait for page to be fully loaded (GIB should pass with real profile)
  console.log("[2] Waiting for page to load...");

  // Check if GIB challenge is still active
  for (let attempt = 0; attempt < 12; attempt++) {
    const title = await page.title();
    const url = page.url();
    console.log(`  Attempt ${attempt}: title="${title}", url=${url}`);

    const hasContent = await page.evaluate(() => {
      const links = document.querySelectorAll("a[href]").length;
      const imgs = document.querySelectorAll("img").length;
      return { links, imgs, bodyLen: document.body?.innerHTML?.length ?? 0 };
    });
    console.log(`  Content: ${hasContent.links} links, ${hasContent.imgs} imgs, ${hasContent.bodyLen} chars`);

    if (hasContent.links > 10 || hasContent.imgs > 3) {
      console.log("  Page loaded successfully!");
      break;
    }

    if (attempt === 5) {
      // Try navigating to sale page
      console.log("  Navigating to sale page...");
      await page.goto(SALE_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }

    await delay(5_000);
  }

  // Get cookies
  const cookies = await page.cookies();
  const cookieString = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  console.log(`[3] Got ${cookies.length} cookies`);

  // Try to discover categoryId by intercepting
  let discoveredCategoryId: string | null = null;

  // First, try scrolling to trigger API calls
  console.log("[4] Scrolling to trigger API calls...");
  const interceptedProducts: any[] = [];

  page.on("response", async (response) => {
    const url = response.url();
    if (url.includes("/front/api/catalog/products")) {
      console.log(`  [API] ${url.substring(0, 120)}`);
      const match = url.match(/categoryId=([^&]+)/);
      if (match && !discoveredCategoryId) {
        discoveredCategoryId = match[1];
        console.log(`  [Discovery] categoryId: ${discoveredCategoryId}`);
      }
      try {
        const json = await response.json();
        const items = json?.data?.products ?? json?.products ?? [];
        if (items.length > 0) {
          console.log(`    -> ${items.length} products`);
          interceptedProducts.push(...items);
        }
      } catch {}
    }
  });

  // Scroll down to trigger lazy loading
  for (let i = 0; i < 5; i++) {
    await page.evaluate((y) => window.scrollTo(0, y), (i + 1) * 800);
    await delay(2_000);
  }

  // Also try to extract categoryId from the page's DOM/scripts
  if (!discoveredCategoryId) {
    discoveredCategoryId = await page.evaluate(() => {
      // Check URL params
      const urlParams = new URLSearchParams(window.location.search);
      const fromUrl = urlParams.get("categoryId");
      if (fromUrl) return fromUrl;

      // Check __NEXT_DATA__
      const nextData = (window as any).__NEXT_DATA__;
      if (nextData?.props?.pageProps?.categoryId) return nextData.props.pageProps.categoryId;

      // Check any script tags with category data
      const scripts = document.querySelectorAll("script");
      for (const script of scripts) {
        const text = script.textContent ?? "";
        const match = text.match(/categoryId["\s:=]+["']?([a-zA-Z0-9-]+)/);
        if (match) return match[1];
      }

      return null;
    });
  }

  console.log(`  Discovered categoryId: ${discoveredCategoryId || "none"}`);

  // Collect products
  const allProducts: Product[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  // First, add intercepted products
  for (const item of interceptedProducts) {
    const product = parseProduct(item, now);
    if (product && !seenIds.has(product.id)) {
      seenIds.add(product.id);
      allProducts.push(product);
    }
  }
  console.log(`[5] Products from interception: ${allProducts.length}`);

  // Now fetch all pages via API
  const categoryIds = [
    discoveredCategoryId,
    "cat570001",
    "1000",
    "sale",
  ].filter(Boolean) as string[];

  const headers: Record<string, string> = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
    Referer: SALE_URL,
    Origin: SITE_URL,
    Cookie: cookieString,
  };

  for (const catId of categoryIds) {
    if (allProducts.length > 0 && catId !== categoryIds[0]) continue;

    console.log(`\n[6] Fetching API with categoryId=${catId}...`);

    for (let pageNum = 0; pageNum < 50; pageNum++) {
      const url = `${SITE_URL}/front/api/catalog/products?categoryId=${catId}&cityId=${MOSCOW_CITY_ID}&pageNumber=${pageNum}`;

      try {
        const resp = await fetch(url, { headers });

        if (!resp.ok) {
          const text = await resp.text().catch(() => "");
          console.log(`  Page ${pageNum}: HTTP ${resp.status} — ${text.substring(0, 100)}`);
          if (resp.status === 403) {
            console.log("  403 Forbidden — trying to fetch via page.evaluate...");
            // Use the browser's context to fetch (with its cookies/session)
            const browserResult = await page.evaluate(async (fetchUrl: string) => {
              try {
                const r = await fetch(fetchUrl, { credentials: "include" });
                if (!r.ok) return { error: r.status };
                return await r.json();
              } catch (e: any) {
                return { error: e.message };
              }
            }, url);

            if (browserResult && !browserResult.error) {
              const items = browserResult?.data?.products ?? browserResult?.products ?? [];
              if (items.length === 0) {
                console.log(`  Page ${pageNum} (browser): empty, done.`);
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
              console.log(`  Page ${pageNum} (browser): ${items.length} items, +${added} (total: ${allProducts.length})`);
              await new Promise((r) => setTimeout(r, 1500));
              continue;
            } else {
              console.log(`  Browser fetch also failed: ${JSON.stringify(browserResult?.error)}`);
              break;
            }
          }
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

        console.log(`  Page ${pageNum}: ${items.length} items, +${added} (total: ${allProducts.length})`);
        await delay(1_500);
      } catch (err) {
        console.error(`  Page ${pageNum} error:`, err);
        break;
      }
    }

    if (allProducts.length > 0) break;
  }

  // If still no products, try fetching directly via browser evaluate for all pages
  if (allProducts.length === 0) {
    console.log("\n[7] Direct API failed. Trying to fetch via browser context...");

    for (const catId of categoryIds) {
      console.log(`  Trying categoryId=${catId} via browser...`);

      for (let pageNum = 0; pageNum < 50; pageNum++) {
        const apiUrl = `${SITE_URL}/front/api/catalog/products?categoryId=${catId}&cityId=${MOSCOW_CITY_ID}&pageNumber=${pageNum}`;

        const result = await page.evaluate(async (url: string) => {
          try {
            const r = await fetch(url, { credentials: "include" });
            if (!r.ok) return { error: r.status, text: await r.text().then(t => t.substring(0, 200)) };
            return await r.json();
          } catch (e: any) {
            return { error: e.message };
          }
        }, apiUrl);

        if (result?.error) {
          console.log(`  Page ${pageNum}: error ${JSON.stringify(result.error)}`);
          break;
        }

        const items = result?.data?.products ?? result?.products ?? [];
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
      }

      if (allProducts.length > 0) break;
    }
  }

  // Save
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== Done! Saved ${sorted.length} products to ${OUTPUT_FILE} ===`);

  // Take screenshot
  try {
    await page.screenshot({ path: join(DATA_DIR, "debug-live.png"), fullPage: false });
    console.log("Screenshot saved to data/debug-live.png");
  } catch {}

  browser.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
