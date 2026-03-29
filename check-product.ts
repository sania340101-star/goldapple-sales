const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// Try individual product page
const productUrl = "https://goldapple.ru/24100100017-vitamino-color-a-ox";
const res = await fetch(productUrl, {
  headers: { "User-Agent": ua, "Accept": "text/html", "Accept-Language": "ru-RU,ru;q=0.9" },
  signal: AbortSignal.timeout(15000),
});
const text = await res.text();
console.log("Product page status:", res.status, "Length:", text.length);
console.log("Title:", text.match(/<title>(.*?)<\/title>/)?.[1]);
if (text.includes("facct")) console.log("GIB check!");

// Try Yandex market XML (some sites expose this)
try {
  const yml = await fetch("https://goldapple.ru/export/yandex_market.xml", {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(10000),
  });
  console.log("\nYML feed:", yml.status, (await yml.text()).substring(0, 200));
} catch(e) { console.log("YML:", e.message); }

// Try Google Merchant feed
try {
  const gm = await fetch("https://goldapple.ru/feeds/google_merchant.xml", {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(10000),
  });
  console.log("\nGoogle Merchant:", gm.status, (await gm.text()).substring(0, 200));
} catch(e) { console.log("Google Merchant:", e.message); }

// Try product-sitemap specifically
try {
  const ps = await fetch("https://goldapple.ru/sitemap-2.xml", {
    headers: { "User-Agent": ua },
    signal: AbortSignal.timeout(15000),
  });
  const psText = await ps.text();
  console.log("\nSitemap-2:", ps.status, "Length:", psText.length);
  // Check if it has price/lastmod info
  const firstEntries = psText.substring(0, 500);
  console.log("First 500:", firstEntries);
} catch(e) { console.log("Sitemap-2:", e.message); }
