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

function parseCardProduct(card: any, now: string, category: string): Product | null {
  const item = card.product ?? card;
  const price = item.price;
  if (!price) return null;

  const currentPrice = price.actual?.amount ?? price.discount?.amount;
  const oldPrice = price.regular?.amount ?? price.old?.amount;
  if (!oldPrice || !currentPrice || oldPrice <= currentPrice) return null;

  const discount =
    price.viewOptions?.discountPercent ??
    Math.round(((oldPrice - currentPrice) / oldPrice) * 100);
  if (discount < 1 || discount > 99) return null;

  const id = String(item.itemId ?? item.id ?? "");
  if (!id) return null;

  const rawImgUrl = item.imageUrls?.[0]?.url ?? "";
  const imageUrl = rawImgUrl
    .replace(/\$\{screen\}/g, "fullhd")
    .replace(/\$\{format\}/g, "webp");

  return {
    id,
    name: item.productType ? `${item.productType} ${item.name}` : (item.name ?? ""),
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

async function main() {
  console.log("=== Gold Apple Sale Scraper (cards-list API) ===\n");
  await mkdir(DATA_DIR, { recursive: true });

  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("goldapple.ru"));
  if (!page) {
    page = await browser.newPage();
    await page.goto(SITE_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await delay(5000);
  }

  console.log(`Connected to: ${page.url()}\n`);

  const allProducts: Product[] = [];
  const seenIds = new Set<string>();
  const now = new Date().toISOString();

  // Sale category slugs
  const saleCategories = [
    { slug: "skidki-vyshli-iz-pod-kontrolja/parfjumerija", name: "Парфюмерия" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/uhod", name: "Уход" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/makijazh", name: "Макияж" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/volosy", name: "Волосы" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/dlja-detej", name: "Для детей" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/tehnika", name: "Техника" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/teens", name: "Teens" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/odezhda-i-aksessuary", name: "Одежда и аксессуары" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/dlja-doma", name: "Для дома" },
    { slug: "skidki-vyshli-iz-pod-kontrolja/sexual-wellness", name: "18+" },
  ];

  // First navigate to the sale page to get cookies/session
  console.log("[1] Setting up session...");
  await page.goto(`${SITE_URL}/skidki-vyshli-iz-pod-kontrolja`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });
  await delay(3000);

  // Close popups
  await page.evaluate(() => {
    document.querySelectorAll("button").forEach((btn) => {
      const t = (btn.textContent ?? "").trim().toLowerCase();
      if (["да, верно", "хорошо", "ок", "принять", "закрыть"].some(x => t.includes(x))) {
        btn.click();
      }
    });
  });
  await delay(1000);

  // Fetch products from each sale category using cards-list API
  console.log("\n[2] Fetching products from sale categories...\n");

  for (const cat of saleCategories) {
    const url = `/${cat.slug}`;
    let pageNum = 0;
    let hasNextPage = true;
    let categoryTotal = 0;

    while (hasNextPage && pageNum < 300) {
      // The cards-list API uses POST with the category URL
      const result = await page.evaluate(async (catUrl: string, pNum: number) => {
        try {
          const r = await fetch("/front/api/catalog/cards-list?locale=ru", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({
              url: catUrl,
              pageNumber: pNum,
            }),
          });
          if (!r.ok) {
            // Try GET approach
            const r2 = await fetch(`/front/api/catalog/cards-list?locale=ru&url=${encodeURIComponent(catUrl)}&pageNumber=${pNum}`, {
              credentials: "include",
            });
            if (!r2.ok) return { error: r2.status };
            return await r2.json();
          }
          return await r.json();
        } catch (e: any) {
          return { error: e.message };
        }
      }, url, pageNum);

      if (result.error) {
        // Fallback: navigate to the page and intercept
        if (pageNum === 0) {
          console.log(`  ${cat.name}: API error ${result.error}, trying navigation...`);

          const interceptedCards: any[] = [];
          const handler = async (response: any) => {
            const respUrl = response.url();
            if (respUrl.includes("/front/api/catalog/cards-list")) {
              try {
                const json = await response.json();
                interceptedCards.push(json);
              } catch {}
            }
          };

          page.on("response", handler);
          await page.goto(`${SITE_URL}${url}`, {
            waitUntil: "networkidle2",
            timeout: 60000,
          });
          await delay(3000);
          page.off("response", handler);

          if (interceptedCards.length > 0) {
            const data = interceptedCards[0];
            const cards = data?.data?.cards ?? [];
            const total = data?.data?.productCount ?? 0;

            for (const card of cards) {
              if (card.cardType === "product") {
                const product = parseCardProduct(card, now, cat.name);
                if (product && !seenIds.has(product.id)) {
                  seenIds.add(product.id);
                  allProducts.push(product);
                  categoryTotal++;
                }
              }
            }

            console.log(`  ${cat.name}: got ${cards.length} cards from navigation (${total} total in category), +${categoryTotal} products`);

            // Now try to paginate via scrolling/network interception
            hasNextPage = data?.data?.pagination?.nextPage ?? false;
            if (hasNextPage) {
              // Scroll to trigger more loads
              for (let scroll = 0; scroll < 100 && hasNextPage; scroll++) {
                const moreCards: any[] = [];
                const scrollHandler = async (response: any) => {
                  const respUrl = response.url();
                  if (respUrl.includes("/front/api/catalog/cards-list")) {
                    try {
                      const json = await response.json();
                      moreCards.push(json);
                    } catch {}
                  }
                };

                page.on("response", scrollHandler);
                await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
                await delay(2000);

                // Try clicking "show more"
                await page.evaluate(() => {
                  document.querySelectorAll("button").forEach((btn) => {
                    const t = (btn.textContent ?? "").trim().toLowerCase();
                    if (t.includes("показать ещё") || t.includes("загрузить ещё")) {
                      btn.click();
                    }
                  });
                });
                await delay(2000);
                page.off("response", scrollHandler);

                if (moreCards.length > 0) {
                  for (const mcData of moreCards) {
                    const mcCards = mcData?.data?.cards ?? [];
                    for (const card of mcCards) {
                      if (card.cardType === "product") {
                        const product = parseCardProduct(card, now, cat.name);
                        if (product && !seenIds.has(product.id)) {
                          seenIds.add(product.id);
                          allProducts.push(product);
                          categoryTotal++;
                        }
                      }
                    }
                    hasNextPage = mcData?.data?.pagination?.nextPage ?? false;
                  }

                  if (scroll % 10 === 0) {
                    console.log(`    scroll ${scroll}: +${categoryTotal} products, total: ${allProducts.length}`);
                  }
                } else {
                  // Check if page still has scroll room
                  const atBottom = await page.evaluate(() => {
                    return window.scrollY + window.innerHeight >= document.body.scrollHeight - 200;
                  });
                  if (atBottom) hasNextPage = false;
                }
              }
            }
          }
        }
        break;
      }

      // Process cards-list API response
      const cards = result?.data?.cards ?? [];
      const total = result?.data?.productCount ?? 0;
      hasNextPage = result?.data?.pagination?.nextPage ?? false;

      if (cards.length === 0) break;

      for (const card of cards) {
        if (card.cardType === "product") {
          const product = parseCardProduct(card, now, cat.name);
          if (product && !seenIds.has(product.id)) {
            seenIds.add(product.id);
            allProducts.push(product);
            categoryTotal++;
          }
        }
      }

      if (pageNum % 5 === 0) {
        console.log(`  ${cat.name}: page ${pageNum}/${Math.ceil(total / 20)}, +${categoryTotal} products (total: ${allProducts.length})`);
      }

      pageNum++;
      await delay(600);
    }

    console.log(`  ${cat.name}: DONE — ${categoryTotal} products from this category\n`);
  }

  // Save results
  const sorted = [...allProducts].sort((a, b) => b.discount - a.discount);
  await writeFile(OUTPUT_FILE, JSON.stringify(sorted, null, 2), "utf-8");
  console.log(`\n=== DONE! Saved ${sorted.length} products to ${OUTPUT_FILE} ===`);

  if (sorted.length > 0) {
    console.log(`\nTop 10 discounts:`);
    for (const p of sorted.slice(0, 10)) {
      console.log(`  -${p.discount}% ${p.brand} — ${p.name} (${p.price}₽, was ${p.oldPrice}₽)`);
    }

    // Stats
    const categories = [...new Set(sorted.map(p => p.category))];
    console.log(`\nCategories: ${categories.join(", ")}`);
    console.log(`Avg discount: ${Math.round(sorted.reduce((s, p) => s + p.discount, 0) / sorted.length)}%`);
  }

  browser.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
