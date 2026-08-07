import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { crawlHelpSite, crawlMarketingSite } from "./crawlHelpSite.js";
import type { HelpCorpus } from "./helpTypes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, "..", "knowledge");

const HELP_OUT       = path.join(KNOWLEDGE_DIR, "help-corpus.json");
const MARKETING_OUT  = path.join(KNOWLEDGE_DIR, "marketing-corpus.json");
const COMBINED_OUT   = path.join(KNOWLEDGE_DIR, "combined-corpus.json");

async function main() {
  const target = process.env.CRAWL_TARGET ?? "all"; // "help" | "marketing" | "all"
  const maxEnv = process.env.CRAWL_MAX_PAGES;
  const maxPages = maxEnv ? parseInt(maxEnv, 10) : undefined;

  await fs.mkdir(KNOWLEDGE_DIR, { recursive: true });

  let helpCorpus: HelpCorpus | null     = null;
  let marketingCorpus: HelpCorpus | null = null;

  // ── Crawl help.rivyo.com ──────────────────────────────────────
  if (target === "help" || target === "all") {
    console.error("📚 Crawling help.rivyo.com …");
    helpCorpus = await crawlHelpSite({
      maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
    });
    await fs.writeFile(HELP_OUT, JSON.stringify(helpCorpus, null, 2), "utf-8");
    console.error(`   ✅ ${helpCorpus.pages.length} pages → ${HELP_OUT}`);
  }

  // ── Crawl rivyo.com marketing site ───────────────────────────
  if (target === "marketing" || target === "all") {
    console.error("🌐 Crawling rivyo.com (marketing) …");
    marketingCorpus = await crawlMarketingSite({
      maxPages: Number.isFinite(maxPages) ? maxPages : undefined,
    });
    await fs.writeFile(MARKETING_OUT, JSON.stringify(marketingCorpus, null, 2), "utf-8");
    console.error(`   ✅ ${marketingCorpus.pages.length} pages → ${MARKETING_OUT}`);
  }

  // ── Merge both into combined-corpus.json ──────────────────────
  if (target === "all" && helpCorpus && marketingCorpus) {
    const combined: HelpCorpus = {
      crawledAt: new Date().toISOString(),
      baseUrl: "https://rivyo.com",
      pages: [
        ...helpCorpus.pages,
        ...marketingCorpus.pages,
      ],
    };
    await fs.writeFile(COMBINED_OUT, JSON.stringify(combined, null, 2), "utf-8");
    console.error(`   ✅ Combined ${combined.pages.length} pages → ${COMBINED_OUT}`);
  }

  console.error("🎉 Crawl complete.");
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});