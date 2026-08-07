import * as cheerio from "cheerio";
import type { HelpCorpus, HelpPageRecord } from "./helpTypes.js";

// ── Site configs ─────────────────────────────────────────────────────────────
const HELP_BASE      = "https://help.rivyo.com";
const MARKETING_BASE = "https://rivyo.com";

const DEFAULT_DELAY_MS  = 400;
const DEFAULT_MAX_PAGES = 800;

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|woff2?|ttf|map)$/i;

// rivyo.com paths to skip (auth, checkout, account, API noise)
const MARKETING_SKIP = /^\/(account|cart|checkout|orders|admin|cdn|s\/|policies\/|search)/i;

export type CrawlOptions = {
  delayMs?: number;
  maxPages?: number;
  signal?: AbortSignal;
};

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// ── Path normalizers ──────────────────────────────────────────────────────────

export function normalizeHelpPath(href: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return null;
  let pathname: string;
  try {
    const u = new URL(href, HELP_BASE);
    if (u.hostname !== "help.rivyo.com") return null;
    pathname = u.pathname;
  } catch {
    return null;
  }
  if (ASSET_EXT.test(pathname)) return null;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return pathname || "/";
}

export function normalizeMarketingPath(href: string): string | null {
  if (!href || href.startsWith("#") || href.startsWith("mailto:")) return null;
  let pathname: string;
  try {
    const u = new URL(href, MARKETING_BASE);
    if (u.hostname !== "rivyo.com" && u.hostname !== "www.rivyo.com") return null;
    pathname = u.pathname;
  } catch {
    return null;
  }
  if (ASSET_EXT.test(pathname)) return null;
  if (MARKETING_SKIP.test(pathname)) return null;
  if (pathname.length > 1 && pathname.endsWith("/")) pathname = pathname.slice(0, -1);
  return pathname || "/";
}

// ── Link extractors ───────────────────────────────────────────────────────────

export function extractLinksFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const paths = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const p = normalizeHelpPath(href.split("#")[0] ?? "");
    if (p) paths.add(p);
  });
  return [...paths];
}

export function extractMarketingLinksFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const paths = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const p = normalizeMarketingPath(href.split("#")[0] ?? "");
    if (p) paths.add(p);
  });
  return [...paths];
}

// ── Content extractors ────────────────────────────────────────────────────────

export function extractPageFromHtml(
  html: string,
  pageUrl: string
): Pick<HelpPageRecord, "title" | "text"> {
  const $ = cheerio.load(html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim() || "Untitled";

  // help.rivyo.com uses #page-content / <main>
  const prose = $("#page-content").first();
  const raw = prose.length > 0 ? prose.text() : $("main").first().text();
  const text = raw.replace(/\s+/g, " ").trim();
  return { title, text: text.length > 0 ? text : `(No body text extracted) ${pageUrl}` };
}

export function extractMarketingPageFromHtml(
  html: string,
  pageUrl: string
): Pick<HelpPageRecord, "title" | "text"> {
  const $ = cheerio.load(html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim() || "Untitled";

  // rivyo.com marketing layout — try common content containers in priority order
  const selectors = [
    "main",
    "article",
    '[class*="content"]',
    '[class*="page"]',
    '[id*="content"]',
    "section",
    "body",
  ];

  let raw = "";
  for (const sel of selectors) {
    const el = $(sel).first();
    if (el.length > 0) {
      // Remove nav / footer / script noise
      el.find("nav, footer, script, style, noscript, [aria-hidden='true']").remove();
      raw = el.text();
      if (raw.replace(/\s+/g, "").length > 80) break;
    }
  }

  const text = raw.replace(/\s+/g, " ").trim();
  return { title, text: text.length > 0 ? text : `(No body text extracted) ${pageUrl}` };
}

// ── Crawlers ──────────────────────────────────────────────────────────────────

/** Crawl help.rivyo.com (help docs, articles, guides) */
export async function crawlHelpSite(options: CrawlOptions = {}): Promise<HelpCorpus> {
  const delayMs  = options.delayMs  ?? DEFAULT_DELAY_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const signal   = options.signal;

  const seedPaths = ["/", "/reviews", "/loyalty"];
  const queue: string[]         = [...seedPaths];
  const visited   = new Set<string>();
  const pages: HelpPageRecord[] = [];
  let   skipped   = 0;
  const startedAt = Date.now();

  const headers = {
    "user-agent": "RivyoMCP-HelpCrawler/1.0 (+https://rivyo.com)",
    accept: "text/html,application/xhtml+xml",
  };

  console.error(`\n🕷️  [help.rivyo.com] Starting crawl`);
  console.error(`   seed pages : ${seedPaths.join(", ")}`);
  console.error(`   max pages  : ${maxPages}`);
  console.error(`   delay      : ${delayMs}ms\n`);

  while (queue.length > 0 && pages.length < maxPages) {
    const p = queue.shift()!;
    if (visited.has(p)) continue;
    visited.add(p);

    const url      = `${HELP_BASE}${p}`;
    const pageNum  = pages.length + 1;
    const elapsed  = ((Date.now() - startedAt) / 1000).toFixed(1);

    process.stderr.write(
      `   [${String(pageNum).padStart(4)}/${maxPages}] ⏳ fetching  ${p} … `
    );

    let html: string;
    let status: number | null = null;
    try {
      const t0  = Date.now();
      const res = await fetch(url, { headers, signal });
      status    = res.status;
      const ms  = Date.now() - t0;

      if (!res.ok) {
        process.stderr.write(`❌ HTTP ${status} (${ms}ms)\n`);
        skipped++;
        continue;
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) {
        process.stderr.write(`⏭️  skipped (${ct})\n`);
        skipped++;
        continue;
      }
      html = await res.text();
      process.stderr.write(`✅ ${status} (${ms}ms)\n`);
    } catch (err) {
      process.stderr.write(`💥 error: ${(err as Error).message}\n`);
      skipped++;
      continue;
    }

    const { title, text } = extractPageFromHtml(html, url);
    const newLinks        = extractLinksFromHtml(html).filter(
      next => !visited.has(next) && !queue.includes(next)
    );

    pages.push({ path: p, url, title, text });

    console.error(
      `        📄 "${title}" | chars: ${text.length} | new links: ${newLinks.length} | queue: ${queue.length + newLinks.length} | elapsed: ${elapsed}s`
    );

    for (const next of newLinks) queue.push(next);

    if (queue.length > 0 && delayMs > 0) await delay(delayMs);
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`\n✅ [help.rivyo.com] Done`);
  console.error(`   crawled : ${pages.length} pages`);
  console.error(`   skipped : ${skipped} pages`);
  console.error(`   time    : ${totalSec}s\n`);

  return { crawledAt: new Date().toISOString(), baseUrl: HELP_BASE, pages };
}

/** Crawl rivyo.com marketing site (features, pricing pages, blog, landing pages) */
export async function crawlMarketingSite(options: CrawlOptions = {}): Promise<HelpCorpus> {
  const delayMs  = options.delayMs  ?? DEFAULT_DELAY_MS;
  const maxPages = options.maxPages ?? 200;
  const signal   = options.signal;

  const seedPaths = [
    "/",
    "/pricing",
    "/features",
    "/blog",
    "/apps",
    "/integrations",
    "/about",
    "/contact",
  ];

  const queue: string[]         = [...seedPaths];
  const visited   = new Set<string>();
  const pages: HelpPageRecord[] = [];
  let   skipped   = 0;
  const startedAt = Date.now();

  const headers = {
    "user-agent": "RivyoMCP-MarketingCrawler/1.0 (+https://rivyo.com)",
    accept: "text/html,application/xhtml+xml",
  };

  console.error(`\n🕷️  [rivyo.com] Starting crawl`);
  console.error(`   seed pages : ${seedPaths.join(", ")}`);
  console.error(`   max pages  : ${maxPages}`);
  console.error(`   delay      : ${delayMs}ms\n`);

  while (queue.length > 0 && pages.length < maxPages) {
    const p = queue.shift()!;
    if (visited.has(p)) continue;
    visited.add(p);

    const url     = `${MARKETING_BASE}${p}`;
    const pageNum = pages.length + 1;
    const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

    process.stderr.write(
      `   [${String(pageNum).padStart(4)}/${maxPages}] ⏳ fetching  ${p} … `
    );

    let html: string;
    let status: number | null = null;
    try {
      const t0  = Date.now();
      const res = await fetch(url, { headers, signal });
      status    = res.status;
      const ms  = Date.now() - t0;

      if (!res.ok) {
        process.stderr.write(`❌ HTTP ${status} (${ms}ms)\n`);
        skipped++;
        continue;
      }
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) {
        process.stderr.write(`⏭️  skipped (${ct})\n`);
        skipped++;
        continue;
      }
      html = await res.text();
      process.stderr.write(`✅ ${status} (${ms}ms)\n`);
    } catch (err) {
      process.stderr.write(`💥 error: ${(err as Error).message}\n`);
      skipped++;
      continue;
    }

    const { title, text } = extractMarketingPageFromHtml(html, url);
    const newLinks        = extractMarketingLinksFromHtml(html).filter(
      next => !visited.has(next) && !queue.includes(next)
    );

    pages.push({ path: p, url, title, text });

    console.error(
      `        📄 "${title}" | chars: ${text.length} | new links: ${newLinks.length} | queue: ${queue.length + newLinks.length} | elapsed: ${elapsed}s`
    );

    for (const next of newLinks) queue.push(next);

    if (queue.length > 0 && delayMs > 0) await delay(delayMs);
  }

  const totalSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.error(`\n✅ [rivyo.com] Done`);
  console.error(`   crawled : ${pages.length} pages`);
  console.error(`   skipped : ${skipped} pages`);
  console.error(`   time    : ${totalSec}s\n`);

  return { crawledAt: new Date().toISOString(), baseUrl: MARKETING_BASE, pages };
}