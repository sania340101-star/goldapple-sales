const res = await fetch("https://goldapple.ru/sale", {
  headers: { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "ru-RU,ru;q=0.9",
  },
  signal: AbortSignal.timeout(15000),
});
const text = await res.text();
console.log("Status:", res.status, "Length:", text.length);

if (text.includes("__NEXT_DATA__")) console.log("Found __NEXT_DATA__!");
if (text.includes("__NUXT__")) console.log("Found __NUXT__!");
if (text.includes("window.__INITIAL")) console.log("Found window.__INITIAL*!");
if (text.includes("facct")) console.log("Has facct (GIB)!");

console.log("Title:", text.match(/<title>(.*?)<\/title>/)?.[1]);

// Check for JSON-LD
const jsonLd = text.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
if (jsonLd) console.log("JSON-LD found:", jsonLd.length, "tags");

// Count script tags
const scripts = text.match(/<script[^>]*>/gi);
console.log("Script tags:", scripts?.length);

// Look for any data in scripts
const dataScripts = text.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
for (const s of dataScripts) {
  if (s.length > 100 && (s.includes("product") || s.includes("price") || s.includes("catalog"))) {
    console.log("Data script (200ch):", s.substring(0, 200));
    console.log("---");
  }
}
