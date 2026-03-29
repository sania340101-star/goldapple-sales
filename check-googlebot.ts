const agents = [
  ["Googlebot", "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
  ["Googlebot-Mobile", "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"],
  ["YandexBot", "Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)"],
  ["curl", "curl/8.0"],
];

for (const [name, ua] of agents) {
  try {
    const res = await fetch("https://goldapple.ru/sale", {
      headers: { "User-Agent": ua, "Accept": "text/html" },
      signal: AbortSignal.timeout(10000),
    });
    const text = await res.text();
    const isGib = text.includes("facct") || text.includes("checking device");
    const hasProducts = text.includes("product") && text.length > 50000;
    console.log(`[${name}] ${res.status} | ${text.length} chars | GIB: ${isGib} | Products: ${hasProducts}`);
    if (!isGib && text.length > 30000) {
      console.log("  Title:", text.match(/<title>(.*?)<\/title>/)?.[1]);
      console.log("  Has JSON-LD:", text.includes("application/ld+json"));
      console.log("  First 300:", text.substring(0, 300));
    }
  } catch(e) {
    console.log(`[${name}] ERROR: ${e.message}`);
  }
}
