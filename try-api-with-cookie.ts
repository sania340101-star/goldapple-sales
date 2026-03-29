// Step 1: Get initial cookies from goldapple.ru
const initRes = await fetch("https://goldapple.ru/sale", {
  headers: { 
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Accept": "text/html",
  },
});

// Extract set-cookie
const setCookies = initRes.headers.getSetCookie?.() || [];
console.log("Set-Cookie headers:", setCookies.length);
setCookies.forEach(c => console.log("  ", c.substring(0, 100)));

const cookieStr = setCookies.map(c => c.split(";")[0]).join("; ");
console.log("\nCookie string:", cookieStr.substring(0, 100));

// Step 2: Try settings API  
const settingsRes = await fetch("https://goldapple.ru/web/api/v1/settings", {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Cookie": cookieStr,
    "plaid-platform": "web",
    "plaid-version": "1.0.0",
    "plaid-store-id": "ru",
  },
});
console.log("\nSettings API:", settingsRes.status);
const settingsText = await settingsRes.text();
console.log("Settings body:", settingsText.substring(0, 500));

// Step 3: Try catalog API with plaid headers
const catalogRes = await fetch("https://goldapple.ru/web/api/v1/catalog/products?categoryId=cat570001&pageNumber=0", {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Cookie": cookieStr,
    "plaid-platform": "web",
    "plaid-version": "1.0.0",
    "plaid-store-id": "ru",
    "Accept": "application/json",
  },
});
console.log("\nCatalog API:", catalogRes.status);
const catText = await catalogRes.text();
console.log("Catalog body:", catText.substring(0, 500));

// Step 4: Try another API path
const catalogRes2 = await fetch("https://goldapple.ru/front/api/catalog/products?categoryId=cat570001&cityId=0c5b2444-70a0-4932-980c-b4dc0d3f02b5&pageNumber=0", {
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Cookie": cookieStr,
    "Accept": "application/json",
  },
});
console.log("\nFront API:", catalogRes2.status);
const cat2Text = await catalogRes2.text();
console.log("Front body:", cat2Text.substring(0, 500));
