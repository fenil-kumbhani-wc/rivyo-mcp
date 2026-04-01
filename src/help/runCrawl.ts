import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { crawlHelpSite } from "./crawlHelpSite.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..", "knowledge", "help-corpus.json");

async function main() {
  const maxEnv = process.env.CRAWL_MAX_PAGES;
  const maxPages = maxEnv ? parseInt(maxEnv, 10) : undefined;
  console.error("Crawling help.rivyo.com (polite delay between requests)…");
  const corpus = await crawlHelpSite({
    maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
  });
  await fs.writeFile(OUT, JSON.stringify(corpus, null, 2), "utf-8");
  console.error(`Done: ${corpus.pages.length} pages → ${OUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
