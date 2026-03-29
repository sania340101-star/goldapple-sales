import puppeteer from "puppeteer";

async function main() {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9222",
    defaultViewport: null,
  });
  const pages = await browser.pages();
  let page = pages.find((p) => p.url().includes("goldapple.ru"));
  if (!page) {
    page = await browser.newPage();
    await page.goto("https://goldapple.ru/skidki-vyshli-iz-pod-kontrolja/parfjumerija", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await new Promise(r => setTimeout(r, 5000));
  }

  console.log("Current URL:", page.url());

  // 1. Check __NEXT_DATA__
  const nextData = await page.evaluate(() => {
    const nd = (window as any).__NEXT_DATA__;
    if (!nd) return null;
    return JSON.stringify(nd).substring(0, 2000);
  });
  console.log("\n=== __NEXT_DATA__ ===");
  console.log(nextData ? nextData.substring(0, 1500) : "NOT FOUND");

  // 2. Check for __INITIAL_STATE__ or similar
  const stateKeys = await page.evaluate(() => {
    const keys: string[] = [];
    for (const k of Object.keys(window)) {
      if (k.startsWith("__") || k.includes("state") || k.includes("State") || k.includes("store") || k.includes("Store") || k.includes("data") || k.includes("Data")) {
        keys.push(k);
      }
    }
    return keys;
  });
  console.log("\n=== Window keys ===");
  console.log(stateKeys.join(", "));

  // 3. Check for script tags with JSON data
  const scriptData = await page.evaluate(() => {
    const results: string[] = [];
    const scripts = document.querySelectorAll('script[type="application/json"], script[type="application/ld+json"], script:not([src])');
    for (const s of scripts) {
      const t = s.textContent ?? "";
      if (t.includes("product") || t.includes("price") || t.includes("catalog") || t.includes("categoryId")) {
        results.push(t.substring(0, 500));
      }
    }
    return results;
  });
  console.log("\n=== Script data with products/prices ===");
  for (const s of scriptData.slice(0, 5)) {
    console.log(s);
    console.log("---");
  }

  // 4. Try to find product cards in DOM
  const productCards = await page.evaluate(() => {
    const selectors = [
      '[class*="roduct"]',
      '[class*="ard"]',
      '[data-testid]',
      '[itemtype]',
    ];
    const results: Record<string, number> = {};
    for (const sel of selectors) {
      const count = document.querySelectorAll(sel).length;
      if (count > 0) results[sel] = count;
    }

    const allText = document.body.innerText;
    const priceMatches = allText.match(/\d[\d\s]*₽/g);

    return {
      selectors: results,
      priceCount: priceMatches?.length ?? 0,
      priceSamples: priceMatches?.slice(0, 10),
      bodyTextLength: allText.length,
    };
  });
  console.log("\n=== DOM analysis ===");
  console.log(JSON.stringify(productCards, null, 2));

  // 5. Try fetching the catalog API directly with various known patterns
  console.log("\n=== API probing ===");
  const apiTests = [
    "/front/api/catalog/products?categoryId=1000000007&cityId=0c5b2444-70a0-4932-980c-b4dc0d3f02b5&pageNumber=0",
    "/front/api/catalog/products?categoryId=1000000001&cityId=0c5b2444-70a0-4932-980c-b4dc0d3f02b5&pageNumber=0",
    "/front/api/catalog/products?slug=skidki-vyshli-iz-pod-kontrolja&pageNumber=0",
    "/front/api/catalog/products?slug=parfjumerija&pageNumber=0",
    "/front/api/catalog/category?slug=skidki-vyshli-iz-pod-kontrolja",
    "/front/api/category/info?slug=skidki-vyshli-iz-pod-kontrolja",
    "/front/api/catalog/products?pageNumber=0&sortBy=discount&sortDir=desc",
    "/front/api/promotion/products?slug=skidki-vyshli-iz-pod-kontrolja&pageNumber=0",
  ];

  for (const url of apiTests) {
    const result = await page.evaluate(async (u: string) => {
      try {
        const r = await fetch(u, { credentials: "include" });
        const text = await r.text();
        return { status: r.status, len: text.length, body: text.substring(0, 400) };
      } catch (e: any) {
        return { status: 0, len: 0, body: e.message };
      }
    }, url);
    console.log(`  ${result.status} [${result.len}b] ${url}`);
    if (result.status === 200 && result.len > 100) {
      console.log(`    ${result.body.substring(0, 300)}`);
    }
  }

  // 6. Monitor XHR/Fetch requests when navigating
  console.log("\n=== Monitoring network while navigating to sale page ===");
  const interceptedUrls: string[] = [];

  page.on("response", async (response: any) => {
    const url = response.url();
    if (url.includes("goldapple.ru") && !url.includes("analytics") && !url.includes("google") && !url.includes(".js") && !url.includes(".css") && !url.includes(".png") && !url.includes(".svg") && !url.includes(".woff")) {
      const ct = response.headers()["content-type"] ?? "";
      if (ct.includes("json") || ct.includes("text/html")) {
        interceptedUrls.push(`${response.status()} [${ct.substring(0,30)}] ${url.substring(0, 150)}`);
      }
    }
  });

  await page.goto("https://goldapple.ru/skidki-vyshli-iz-pod-kontrolja/uhod", {
    waitUntil: "networkidle2",
    timeout: 60000,
  });
  await new Promise(r => setTimeout(r, 3000));

  console.log("Intercepted requests:");
  for (const u of interceptedUrls) {
    console.log(`  ${u}`);
  }

  browser.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
