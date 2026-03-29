import puppeteer from "puppeteer";
import { writeFile, mkdir } from "fs/promises";
import { join } from "path";

const DATA_DIR = join(import.meta.dir, "data");
const OUTPUT_FILE = join(DATA_DIR, "products.json");
const SITE_URL = "https://goldapple.ru";
const BASE_SALE_URL = `${SITE_URL}/skidki-vyshli-iz-pod-kontrolja`;

const CATEGORIES = [
  "", // main page
  "/parfjumerija",
  "/uhod",
  "/makijazh",
  "/volosy",
  "/sexual-wellness",
  "/dlja-detej",
  "/tehnika",
  "/teens",
  "/odezhda-i-aksessuary",
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface RawCard {
  url: string;
  name: string;
  brand: string;
  category: string;
  currentPrice: number;
  oldPrice: number;
  discount: number;
  image: string;
  rating: number;
  reviews: number;
}

async function extractCards(page: any): Promise<RawCard[]> {
  return page.evaluate(() => {
    const results: any[] = [];

    // Find product links
    const links = document.querySelectorAll('a[href*="goldapple.ru/"]');

    for (const link of links) {
      const href = (link as HTMLAnchorElement).pathname;
      // Product URLs look like /19000240976-toy-2-pearl (number-slug)
      if (!/^\/\d{5,}-/.test(href)) continue;

      const fullUrl = (link as HTMLAnchorElement).href;

      // Find the product card container (go up a few levels)
      let card: Element | null = link as Element;
      for (let i = 0; i < 5; i++) {
        if (!card?.parentElement) break;
        card = card.parentElement;
        // Stop at elements that seem like card containers
        if (card.className && card.children.length > 2) break;
      }
      if (!card) continue;

      // Extract text from specific child elements
      const allText = card.textContent ?? "";

      // Extract prices — look for ₽ symbols
      const priceMatches = allText.match(/(\d[\d\s]*)\s*₽/g);
      if (!priceMatches || priceMatches.length === 0) continue;

      // Parse all numeric values near ₽
      const prices = priceMatches.map((m) => {
        const num = m.replace(/[^\d]/g, "");
        return parseInt(num, 10);
      }).filter((n) => n > 0);

      if (prices.length === 0) continue;

      // Images
      const img = card.querySelector("img");
      const imgSrc = img?.src ?? img?.getAttribute("data-src") ?? "";

      // Determine current and old price
      // Pattern: "от X ₽×4платежаот Y ₽" means X is installment, Y is total current price
      // Or "от X ₽" only means X is current price
      // We look for discount badge
      const discountMatch = allText.match(/[-−](\d+)%/);
      const discountPercent = discountMatch ? parseInt(discountMatch[1], 10) : 0;

      // Get the two most relevant prices
      let currentPrice = 0;
      let oldPrice = 0;

      if (prices.length >= 2) {
        // If there's installment: "от X ₽×4платежа от Y ₽"
        // X is per-installment, Y is total
        // But we also might see: "от X ₽ от Y ₽" where X is sale, Y is original
        // Or crossed out old price

        // Find crossed out / old price elements
        const strikeEl = card.querySelector('[class*="old"], [class*="Old"], [class*="cross"], [class*="previous"], s, del, [style*="line-through"]');
        const strikeText = strikeEl?.textContent ?? "";
        const strikePrice = strikeText.match(/(\d[\d\s]*)\s*₽/);

        if (strikePrice) {
          oldPrice = parseInt(strikePrice[1].replace(/\s/g, ""), 10);
          // Current price is the smallest non-installment price
          currentPrice = prices.filter(p => p !== oldPrice).sort((a, b) => a - b)[0] ?? prices[0];
        } else if (discountPercent > 0) {
          // Use the biggest price as old, smallest as current
          currentPrice = Math.min(...prices);
          oldPrice = Math.max(...prices);

          // If installment pattern detected (×4), skip installment price
          if (allText.includes("×4") && prices.length >= 2) {
            const sorted = [...prices].sort((a, b) => a - b);
            // Installment is the smallest, then current, then old
            if (sorted.length >= 3) {
              currentPrice = sorted[1]; // middle = current
              oldPrice = sorted[2]; // biggest = old
            } else {
              currentPrice = sorted[0];
              oldPrice = sorted[1];
            }
          }
        } else {
          // No explicit discount — last price is usually old
          currentPrice = prices[prices.length - 2] ?? prices[0];
          oldPrice = prices[prices.length - 1];
        }
      } else {
        currentPrice = prices[0];
      }

      // Rating and reviews
      const ratingMatch = allText.match(/(\d\.\d)\s*(\d+)/);
      const rating = ratingMatch ? parseFloat(ratingMatch[1]) : 0;
      const reviews = ratingMatch ? parseInt(ratingMatch[2], 10) : 0;

      // Brand and name — hard to separate from concatenated text
      // Try to find them from specific elements
      const nameEl = card.querySelector('[class*="name"], [class*="Name"], [class*="title"], [class*="Title"]');
      const brandEl = card.querySelector('[class*="brand"], [class*="Brand"]');

      results.push({
        url: fullUrl,
        name: nameEl?.textContent?.trim() ?? "",
        brand: brandEl?.textContent?.trim() ?? "",
        category: "",
        currentPrice,
        oldPrice,
        discount: discountPercent || (oldPrice > currentPrice ? Math.round(((oldPrice - currentPrice) / oldPrice) * 100) : 0),
        image: imgSrc,
        rating,
        reviews,
      });
    }

    return results;
  });
}

async function scrollToEnd(page: any): Promise<void> {
  let lastHeight = 0;
  let stableCount = 0;

  for (let i = 0; i < 80; i++) {
    // Click "show more" button if exists
    const clicked = await page.evaluate(() => {
      const btns = document.querySelectorAll("button");
      for (const btn of btns) {
        const text = btn.textContent?.trim()?.toLowerCase() ?? "";
        if (text.includes("показать ещё") || text.includes("загрузить ещё") || text.includes("ещё товары")) {
          btn.click();
          return true;
        }
      }
      return false;
    });

    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(clicked ? 3_000 : 1_500);

    const height = await page.evaluate(() => document.body.scrollHeight);
    if (height === lastHeight) {
      stableCount++;
      if (stableCount >= 3) break;
    } else {
      stableCount = 0;
    }
    lastHeight = height;
  }
}

async function main() {
  console.log("=== Gold Apple Card Scraper ===");
  await mkdir(DATA_DIR, { recursive: true });

  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });

  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("goldapple.ru"));
  if (!page) page = await browser.newPage();

  // Close popups
  const closePopups = async () => {
    await page!.evaluate(() => {
      document.querySelectorAll("button").forEach((btn) => {
        const text = btn.textContent?.trim()?.toLowerCase() ?? "";
        if (text === "да, верно" || text === "хорошо" || text === "ок") btn.click();
      });
    });
    await delay(500);
  };

  const allCards: RawCard[] = [];
  const seenUrls = new Set<string>();
  const now = new Date().toISOString();

  for (const category of CATEGORIES) {
    const url = `${BASE_SALE_URL}${category}`;
    const catName = category.replace("/", "") || "main";
    console.log(`\n[${catName}] ${url}`);

    try {
      await page.goto(url, { waitUntil: "networkidle2", timeout: 60_000 });
      await delay(2_000);
      await closePopups();

      // Scroll to load all products
      console.log(`  Scrolling...`);
      await scrollToEnd(page);

      // Extract cards
      const cards = await extractCards(page);
      let newCount = 0;
      for (const card of cards) {
        if (!seenUrls.has(card.url)) {
          seenUrls.add(card.url);
          card.category = catName;
          allCards.push(card);
          newCount++;
        }
      }
      console.log(`  Found ${cards.length} cards, ${newCount} new (total: ${allCards.length})`);
    } catch (err) {
      console.log(`  Error: ${err}`);
    }
  }

  // Convert to product format
  const products = allCards
    .filter((c) => c.discount > 0 || c.oldPrice > c.currentPrice)
    .map((c) => ({
      id: c.url.match(/\/(\d{5,})-/)?.[1] ?? c.url.split("/").pop() ?? "",
      name: c.name,
      brand: c.brand,
      price: c.currentPrice,
      oldPrice: c.oldPrice,
      discount: c.discount,
      imageUrl: c.image,
      productUrl: c.url,
      category: c.category,
      rating: c.rating,
      reviewsCount: c.reviews,
      scrapedAt: now,
    }))
    .sort((a, b) => b.discount - a.discount);

  await writeFile(OUTPUT_FILE, JSON.stringify(products, null, 2), "utf-8");
  console.log(`\n=== DONE! Saved ${products.length} products (from ${allCards.length} total cards) ===`);

  // Also save raw cards for debugging
  await writeFile(join(DATA_DIR, "raw-cards.json"), JSON.stringify(allCards, null, 2), "utf-8");

  browser.disconnect();
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
