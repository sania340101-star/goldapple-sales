const res = await fetch("https://goldapple.ru/sale", {
  headers: { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html",
  },
  signal: AbortSignal.timeout(10000),
});

// Show headers
console.log("Response headers:");
for (const [k, v] of res.headers.entries()) {
  console.log(`  ${k}: ${v}`);
}

const text = await res.text();
console.log("\n=== FULL HTML ===");
console.log(text);
