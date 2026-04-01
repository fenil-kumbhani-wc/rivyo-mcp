import * as cheerio from "cheerio";
import type { HelpCorpus, HelpPageRecord } from "./helpTypes.js";

// Help center only: same host + Mantle/docs HTML (#page-content, /reviews /loyalty nav).
// rivyo.com is the marketing/storefront site (different layout, paths, and crawl surface)—not covered here.
const HELP_BASE = "https://help.rivyo.com";
const DEFAULT_DELAY_MS = 400;
const DEFAULT_MAX_PAGES = 800;

const ASSET_EXT = /\.(png|jpe?g|gif|svg|webp|ico|css|js|mjs|json|xml|pdf|woff2?|ttf|map)$/i;

export type CrawlOptions = {
  delayMs?: number;
  maxPages?: number;
  signal?: AbortSignal;
};

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

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

export function extractLinksFromHtml(html: string): string[] {
  const $ = cheerio.load(html);
  const paths = new Set<string>();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const path = normalizeHelpPath(href.split("#")[0] ?? "");
    if (path) paths.add(path);
  });
  return [...paths];
}

export function extractPageFromHtml(html: string, pageUrl: string): Pick<HelpPageRecord, "title" | "text"> {
  const $ = cheerio.load(html);
  const title = $("title").first().text().replace(/\s+/g, " ").trim() || "Untitled";
  const prose = $("#page-content").first();
  const raw =
    prose.length > 0
      ? prose.text()
      : $("main").first().text();
  const text = raw.replace(/\s+/g, " ").trim();
  return { title, text: text.length > 0 ? text : `(No body text extracted) ${pageUrl}` };
}

export async function crawlHelpSite(options: CrawlOptions = {}): Promise<HelpCorpus> {
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
  const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
  const signal = options.signal;

  const seedPaths = ["/", "/reviews", "/loyalty"];
  const queue: string[] = [...seedPaths];
  const visited = new Set<string>();
  const pages: HelpPageRecord[] = [];

  const headers = {
    "user-agent": "RivyoMCP-HelpCrawler/1.0 (+https://rivyo.com)",
    accept: "text/html,application/xhtml+xml",
  };

  while (queue.length > 0 && pages.length < maxPages) {
    const path = queue.shift()!;
    if (visited.has(path)) continue;
    visited.add(path);

    const url = `${HELP_BASE}${path === "/" ? "/" : path}`;
    let html: string;
    try {
      const res = await fetch(url, { headers, signal });
      if (!res.ok) continue;
      const ct = res.headers.get("content-type") ?? "";
      if (!ct.includes("text/html")) continue;
      html = await res.text();
    } catch {
      continue;
    }

    const { title, text } = extractPageFromHtml(html, url);
    pages.push({ path, url, title, text });

    for (const next of extractLinksFromHtml(html)) {
      if (!visited.has(next) && !queue.includes(next)) queue.push(next);
    }

    if (queue.length > 0 && delayMs > 0) await delay(delayMs);
  }

  return {
    crawledAt: new Date().toISOString(),
    baseUrl: HELP_BASE,
    pages,
  };
}
