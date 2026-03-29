import puppeteer from "puppeteer";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");
const SITE_URL = "https://goldapple.by";

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

function parseCard(card: any, now: string, category: string): Product | null {
  if (card.cardType !== "product") return null;
  const p = card.product;
  if (!p?.price) return null;

  const denominator = p.price.regular?.denominator ?? p.price.actual?.denominator ?? 100;

  // Discount price structure: regular = old price, discount/actual = current price
  const hasDiscount = !!p.price.discount || (p.price.viewOptions?.useDiscount && p.price.viewOptions?.discountPercent > 0);
  if (!hasDiscount) return null;

  const regularAmount = p.price.regular?.amount;
  const actualAmount = p.price.actual?.amount ?? p.price.discount?.amount;
  if (!regularAmount || !actualAmount || regularAmount <= actualAmount) return null;

  const oldPrice = regularAmount / denominator;
  const currentPrice = actualAmount / denominator;
  const discount = p.price.viewOptions?.discountPercent || Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
  if (discount < 1 || discount > 99) return null;

  const id = String(p.itemId ?? p.id ?? "");
  if (!id) return null;

  const rawImgUrl = p.imageUrls?.[0]?.url ?? "";
  const imageUrl = rawImgUrl
    .replace("${screen}", "fullhd")
    .replace("${format}", "webp");

  return {
    id,
    name: p.name ?? "",
    brand: p.brand ?? "",
    price: currentPrice,
    oldPrice,
    discount,
    imageUrl,
    productUrl: p.url ? `${SITE_URL}${p.url}` : "",
    category,
    rating: p.reviews?.rating ?? 0,
    reviewsCount: p.reviews?.reviewsCount ?? 0,
    scrapedAt: now,
  };
}

// Also parse placement products (different format)
function parsePlacementProduct(item: any, now: string, category: string): Product | null {
  const price = item.price;
  if (!price) return null;

  const currentPrice = price.actual?.amount ?? null;
  const oldPrice = price.old?.amount ?? null;
  if (!oldPrice || !currentPrice || oldPrice <= currentPrice) return null;

  const denominator = price.actual?.denominator ?? price.old?.denominator ?? 100;
  const realCurrent = currentPrice / denominator;
  const realOld = oldPrice / denominator;
  const discount = Math.round(((realOld - realCurrent) / realOld) * 100);
  if (discount < 1 || discount > 99) return null;

  const id = String(item.itemId ?? item.id ?? "");
  if (!id) return null;

  const rawImgUrl = item.imageUrls?.[0]?.url ?? "";
  const imageUrl = rawImgUrl.replace("${screen}", "fullhd").replace("${format}", "webp");

  return {
    id,
    name: item.name ?? "",
    brand: item.brand ?? "",
    price: realCurrent,
    oldPrice: realOld,
    discount,
    imageUrl,
    productUrl: item.url ? `${SITE_URL}${item.url}` : "",
    category,
    rating: item.reviews?.rating ?? 0,
    reviewsCount: item.reviews?.reviewsCount ?? 0,
    scrapedAt: now,
  };
}

async function main() {
  console.log("=== Gold Apple BY Scraper FINAL ===\n");
  await mkdir(DATA_DIR, { recursive: true });

  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const page = await browser.newPage();
  const allProducts: Product[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  // Capture cards-list request template via CDP
  const cdp = await page.createCDPSession();
  await cdp.send("Network.enable");

  let templateHeaders: Record<string, string> = {};
  let templateBody: any = null;

  cdp.on("Network.requestWillBeSent", (params: any) => {
    if (params.request.url.includes("cards-list") && params.request.postData && !templateBody) {
      templateHeaders = params.request.headers;
      templateBody = JSON.parse(params.request.postData);
      console.log(`  Template captured: ${JSON.stringify(templateBody).substring(0, 150)}`);
    }
  });

  // Step 1: Open a category page to capture the template
  console.log("[1] Capturing API template...");
  await page.goto(`${SITE_URL}/parfjumerija`, { waitUntil: "networkidle2", timeout: 60_000 });
  await delay(5_000);

  // Close popups
  try {
    await page.evaluate(() => {
      document.querySelectorAll("button").forEach((btn) => {
        const t = btn.textContent?.trim()?.toLowerCase() ?? "";
        if (["да, верно", "хорошо", "ок", "принять", "закрыть", "понятно", "согласен"].some(x => t.includes(x))) {
          (btn as HTMLElement).click();
        }
      });
    });
  } catch {}

  if (!templateBody) {
    console.log("  Waiting for template...");
    await delay(5_000);
  }

  if (!templateBody) {
    console.log("ERROR: Could not capture API template!");
    await page.close();
    browser.disconnect();
    return;
  }

  // Step 2: Fetch all categories
  console.log("\n[2] Fetching categories...");
  const categories = [
    { id: "2000000007", name: "Парфюмерия" },
    { id: "2000000004", name: "Уход" },
    { id: "2000000003", name: "Макияж" },
    { id: "2000000006", name: "Волосы" },
    { id: "2000805227", name: "Для дома" },
    { id: "2000003870", name: "Одежда и аксессуары" },
  ];

  async function fetchCardsPage(categoryId: string, pageNum: number): Promise<any> {
    const body = {
      ...templateBody,
      categoryId,
      pageNumber: pageNum,
      pageSize: 24,
    };

    return page.evaluate(async (bodyStr: string, headers: Record<string, string>) => {
      const h: Record<string, string> = { "content-type": "application/json" };
      for (const [k, v] of Object.entries(headers)) {
        if (k.startsWith("plaid") || k.startsWith("x-")) h[k] = v;
      }

      const r = await fetch("/front/api/catalog/cards-list?locale=ru", {
        method: "POST",
        credentials: "include",
        headers: h,
        body: bodyStr,
      });
      if (!r.ok) return { error: r.status };
      return await r.json();
    }, JSON.stringify(body), templateHeaders);
  }

  const slugMap: Record<string, string> = {
    "2000000007": "parfjumerija",
    "2000000004": "uhod",
    "2000000003": "makijazh",
    "2000000006": "volosy",
    "2000805227": "dlja-doma",
    "2000003870": "odezhda-i-aksessuary",
  };

  for (const cat of categories) {
    console.log(`\n  [${cat.name}] (id: ${cat.id})`);
    let totalInCat = 0;

    // Navigate to category page first to ensure valid session
    const slug = slugMap[cat.id];
    if (slug) {
      try {
        await page.goto(`${SITE_URL}/${slug}`, { waitUntil: "networkidle2", timeout: 45_000 });
        await delay(3_000);
        // Close popups
        await page.evaluate(() => {
          document.querySelectorAll("button").forEach((btn) => {
            const t = btn.textContent?.trim()?.toLowerCase() ?? "";
            if (["да, верно", "хорошо", "ок", "принять", "закрыть", "понятно", "согласен"].some(x => t.includes(x))) {
              (btn as HTMLElement).click();
            }
          });
        }).catch(() => {});
      } catch (err: any) {
        console.log(`    Nav error: ${err.message?.substring(0, 60)}, skipping`);
        continue;
      }
    }

    for (let pageNum = 1; pageNum <= 300; pageNum++) {
      try {
        const result = await fetchCardsPage(cat.id, pageNum);

        if (result?.error) {
          if (result.error === 405 && pageNum > 1) {
            // Rate limited — wait and retry
            console.log(`    Page ${pageNum}: rate limited, waiting 5s...`);
            await delay(5_000);
            const retry = await fetchCardsPage(cat.id, pageNum);
            if (retry?.error) {
              console.log(`    Page ${pageNum}: still error ${retry.error}, re-navigating...`);
              // Re-navigate to refresh session
              if (slug) {
                try {
                  await page.goto(`${SITE_URL}/${slug}`, { waitUntil: "networkidle2", timeout: 30_000 });
                  await delay(3_000);
                } catch {}
              }
              await delay(2_000);
              const retry2 = await fetchCardsPage(cat.id, pageNum);
              if (retry2?.error) {
                console.log(`    Giving up on page ${pageNum}`);
                break;
              }
              // Process retry2 as normal result below
              const cards2 = retry2?.data?.cards ?? [];
              let added2 = 0;
              for (const card of cards2) {
                const product = parseCard(card, now, cat.name);
                if (product && !seenIds.has(product.id)) {
                  seenIds.add(product.id);
                  allProducts.push(product);
                  added2++;
                  totalInCat++;
                }
              }
              console.log(`    Page ${pageNum}: ${cards2.length} cards, +${added2} discounted (total: ${allProducts.length})`);
              if (!retry2?.data?.pagination?.nextPage) break;
              await delay(1_500);
              continue;
            }
            // Process retry result
            const cards = retry?.data?.cards ?? [];
            let added = 0;
            for (const card of cards) {
              const product = parseCard(card, now, cat.name);
              if (product && !seenIds.has(product.id)) {
                seenIds.add(product.id);
                allProducts.push(product);
                added++;
                totalInCat++;
              }
            }
            console.log(`    Page ${pageNum}: ${cards.length} cards, +${added} discounted (total: ${allProducts.length})`);
            if (!retry?.data?.pagination?.nextPage) break;
            await delay(1_500);
            continue;
          }
          console.log(`    Page ${pageNum} error: ${result.error}`);
          break;
        }

        const cards = result?.data?.cards ?? [];
        if (cards.length === 0) {
          console.log(`    Page ${pageNum}: empty, done (${totalInCat} discounted in category)`);
          break;
        }

        let added = 0;
        for (const card of cards) {
          const product = parseCard(card, now, cat.name);
          if (product && !seenIds.has(product.id)) {
            seenIds.add(product.id);
            allProducts.push(product);
            added++;
            totalInCat++;
          }
        }

        if (pageNum === 1) {
          const totalCards = result?.data?.cardsCount ?? 0;
          const totalPages = Math.ceil(totalCards / 24);
          console.log(`    Total in category: ${totalCards} items, ~${totalPages} pages`);
        }

        console.log(`    Page ${pageNum}: ${cards.length} cards, +${added} discounted (total: ${allProducts.length})`);

        if (!result?.data?.pagination?.nextPage) {
          console.log(`    Last page reached: ${totalInCat} discounted in category`);
          break;
        }

        await delay(1_000);

        await delay(1_200);
      } catch (err: any) {
        console.log(`    Page ${pageNum} error: ${err.message?.substring(0, 60)}`);
        break;
      }
    }
  }

  // Step 3: Placements
  console.log("\n[3] Fetching placements...");
  try {
    const result = await page.evaluate(async () => {
      const sources = ["mainPage", "sectionPage", "catalogPage"];
      const all: any[] = [];
      for (const src of sources) {
        try {
          const r = await fetch(`/front/api/catalog/placements?locale=ru&requestSource=${src}&cityId=relation:59195&geoPolygons[]=BLR-000000003&regionId=relation:59195`, { credentials: "include" });
          if (r.ok) {
            const json = await r.json();
            const placements = json?.data?.placements ?? [];
            for (const p of placements) {
              all.push({ name: p.name, products: p.products ?? [] });
            }
          }
        } catch {}
      }
      return all;
    });

    for (const p of result) {
      let added = 0;
      for (const item of p.products) {
        const product = parsePlacementProduct(item, now, p.name ?? "placement");
        if (product && !seenIds.has(product.id)) {
          seenIds.add(product.id);
          allProducts.push(product);
          added++;
        }
      }
      if (added > 0) console.log(`  "${p.name}": +${added}`);
    }
  } catch {}

  // Save
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== DONE! Saved ${sorted.length} discounted products from goldapple.by ===`);

  if (sorted.length > 0) {
    console.log(`\nTop 5 discounts:`);
    for (const p of sorted.slice(0, 5)) {
      console.log(`  -${p.discount}% ${p.brand} ${p.name}: ${p.price} BYN (was ${p.oldPrice})`);
    }
  }

  await page.close();
  browser.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
