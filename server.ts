import { readFile, stat } from "fs/promises";
import { join } from "path";
import { runScraper } from "./scraper/index";

const PORT = 3000;
const DATA_FILE = join(import.meta.dir, "data", "products.json");
const WEB_DIR = join(import.meta.dir, "web");
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

let isScrapingNow = false;
let lastUpdateTime: string | null = null;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

async function isDataStale(): Promise<boolean> {
  try {
    const stats = await stat(DATA_FILE);
    const age = Date.now() - stats.mtimeMs;
    return age > UPDATE_INTERVAL_MS;
  } catch {
    return true; // File doesn't exist
  }
}

async function triggerScraping(): Promise<void> {
  if (isScrapingNow) {
    console.log("Scraping already in progress, skipping...");
    return;
  }

  isScrapingNow = true;
  console.log("Starting scheduled scraping...");

  try {
    await runScraper();
    lastUpdateTime = new Date().toISOString();
    console.log(`Scraping completed at ${lastUpdateTime}`);
  } catch (err) {
    console.error("Scraping failed:", err);
  } finally {
    isScrapingNow = false;
  }
}

async function getProductsData(): Promise<{ products: unknown[]; lastUpdate: string | null }> {
  try {
    const content = await readFile(DATA_FILE, "utf-8");
    const products = JSON.parse(content) as unknown[];
    const stats = await stat(DATA_FILE);
    return {
      products,
      lastUpdate: lastUpdateTime ?? stats.mtime.toISOString(),
    };
  } catch {
    return { products: [], lastUpdate: null };
  }
}

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf("."));
  return MIME_TYPES[ext] ?? "application/octet-stream";
}

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // API routes
    if (pathname === "/api/products") {
      const { products, lastUpdate } = await getProductsData();
      return Response.json({ products, lastUpdate, count: products.length });
    }

    if (pathname === "/api/status") {
      const { products, lastUpdate } = await getProductsData();
      return Response.json({
        lastUpdate,
        productCount: products.length,
        isScrapingNow,
        nextUpdate: lastUpdate
          ? new Date(new Date(lastUpdate).getTime() + UPDATE_INTERVAL_MS).toISOString()
          : null,
      });
    }

    if (pathname === "/api/scrape" && req.method === "POST") {
      if (isScrapingNow) {
        return Response.json({ error: "Scraping already in progress" }, { status: 409 });
      }
      // Trigger async, don't await
      triggerScraping();
      return Response.json({ message: "Scraping started" });
    }

    // Static files
    const filePath =
      pathname === "/" ? join(WEB_DIR, "index.html") : join(WEB_DIR, pathname);

    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        return new Response(file, {
          headers: { "Content-Type": getMimeType(filePath) },
        });
      }
    } catch {
      // Fall through to 404
    }

    return new Response("Not Found", { status: 404 });
  },
});

console.log(`Server running at http://localhost:${PORT}`);

// Check if data is stale on startup
(async () => {
  if (await isDataStale()) {
    console.log("Data is stale or missing, triggering initial scraping...");
    triggerScraping();
  } else {
    const stats = await stat(DATA_FILE);
    lastUpdateTime = stats.mtime.toISOString();
    console.log(`Data is fresh (last updated: ${lastUpdateTime})`);
  }
})();

// Schedule periodic scraping
setInterval(() => {
  console.log("Scheduled scraping triggered");
  triggerScraping();
}, UPDATE_INTERVAL_MS);
