import { chromium } from "playwright";

async function main() {
  console.log("Launching with debugging port...");
  
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox", 
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
    timeout: 60000,
  });
  
  console.log("Browser launched!");
  const page = await browser.newPage();
  console.log("Page created, navigating...");
  
  await page.goto("https://example.com", { timeout: 15000 });
  console.log("Title:", await page.title());
  
  await browser.close();
  console.log("Done!");
}

main().catch(e => {
  console.error("Failed:", e.message);
  process.exit(1);
});
