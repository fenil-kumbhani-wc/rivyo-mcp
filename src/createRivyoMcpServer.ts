/**
 * Rivyo MCP — internal engineering use only. Not for customers or public-facing agents.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import {
  buildGroundedHelpResponse,
  clipHelpText,
  getHelpArticleByPath,
  listHelpArticles,
  searchHelpStructured,
} from "./help/helpCorpus.js";
import type { HelpCorpus } from "./help/helpTypes.js";

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");
const CORPUS_FILE   = path.join(KNOWLEDGE_DIR, "combined-corpus.json");

// ── Corpus loader (file-level cache) ─────────────────────────────────────────

let _cache: { mtimeMs: number; corpus: HelpCorpus } | null = null;

async function loadCombinedCorpus(): Promise<HelpCorpus | null> {
  try {
    const stat = await fs.stat(CORPUS_FILE);
    if (_cache && _cache.mtimeMs === stat.mtimeMs) return _cache.corpus;
    const raw    = await fs.readFile(CORPUS_FILE, "utf-8");
    const corpus = JSON.parse(raw) as HelpCorpus;
    if (!Array.isArray(corpus.pages)) return null;
    _cache = { mtimeMs: stat.mtimeMs, corpus };
    return corpus;
  } catch {
    return null;
  }
}

function corpusMissing(): string {
  return "No combined-corpus.json found. Run: CRAWL_TARGET=all npm run crawl";
}

// ── Query normalization ───────────────────────────────────────────────────────

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\bprice\b/g,  "pricing")
    .replace(/\bcost\b/g,   "pricing")
    .replace(/\bplan\b/g,   "pricing")
    .replace(/\breview\b/g, "reviews");
}

// ── MCP Server ────────────────────────────────────────────────────────────────

export function createRivyoMcpServer(): McpServer {
  const server = new McpServer(
    { name: "rivyo-mcp", version: "1.0.0" },
    {
      instructions:
        "Use search_rivyo for all queries — searches both help.rivyo.com and rivyo.com from a single combined corpus. If excerpts are incomplete call get_article(p). Browse all pages with list_pages. Always cite u (URL) in answers.",
    }
  );

  // ── search_rivyo ─────────────────────────────────────────────────
  server.tool(
    "search_rivyo",
    "Search all Rivyo content — help docs (help.rivyo.com) and marketing pages (rivyo.com) — from a single combined corpus. Returns ranked excerpts with URLs to cite.",
    {
      query: z
        .string()
        .describe("Natural language query about Rivyo features, reviews, pricing, setup, etc."),
      excerpt_max_chars: z
        .number()
        .min(200)
        .max(20_000)
        .optional()
        .describe("Max chars per excerpt (default 720). Increase if excerpts feel cut off."),
    },
    async ({ query, excerpt_max_chars }) => {
      const corpus = await loadCombinedCorpus();
      if (!corpus) {
        return { content: [{ type: "text", text: corpusMissing() }] };
      }

      const normalizedQuery = normalizeQuery(query);

      // Search normalized query first; fall back to raw query if no hits
      let hits = searchHelpStructured(corpus, normalizedQuery, { limit: 8, maxPerPath: 2 });
      if (hits.length === 0 && normalizedQuery !== query.toLowerCase()) {
        hits = searchHelpStructured(corpus, query, { limit: 8, maxPerPath: 2 });
      }

      if (hits.length === 0) {
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              note: `No results for "${query}". Try different terms or call list_pages to browse all content.`,
              crawled_at: corpus.crawledAt,
              total_pages: corpus.pages.length,
              q: query.trim(),
              r: [],
            }),
          }],
        };
      }

      return {
        content: [{
          type: "text",
          text: buildGroundedHelpResponse(corpus, query, hits, excerpt_max_chars),
        }],
      };
    }
  );

  // ── get_article ───────────────────────────────────────────────────
  server.tool(
    "get_article",
    "Get the full text of a page by its path (p field from search_rivyo results). Use when search excerpts are too short to answer the question.",
    {
      path: z
        .string()
        .describe("Page path from search_rivyo result, e.g. /reviews/getting-started"),
      body_max_chars: z
        .number()
        .min(800)
        .max(100_000)
        .optional()
        .describe("Cap on returned text length. Omit for full page."),
    },
    async ({ path: articlePath, body_max_chars }) => {
      const corpus = await loadCombinedCorpus();
      if (!corpus) return { content: [{ type: "text", text: corpusMissing() }] };

      const page = getHelpArticleByPath(corpus, articlePath);
      if (!page) {
        return {
          content: [{
            type: "text",
            text: `No page at path "${articlePath}". Call list_pages to browse available paths.`,
          }],
        };
      }

      const body      = body_max_chars !== undefined ? clipHelpText(page.text, body_max_chars) : page.text;
      const truncated = body_max_chars !== undefined && page.text.length > body.length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            note: "Full page content. Cite u in your answer.",
            crawled_at: corpus.crawledAt,
            u: page.url,
            p: page.path,
            t: page.title,
            b: body,
            truncated,
          }),
        }],
      };
    }
  );

  // ── list_pages ────────────────────────────────────────────────────
  server.tool(
    "list_pages",
    "List all pages in the combined corpus (help + marketing). Useful when search_rivyo returns no results or you need to find a specific page path.",
    {
      limit: z
        .number()
        .min(1)
        .max(500)
        .optional()
        .describe("Max pages to return (default 80)."),
      filter: z
        .string()
        .optional()
        .describe("Optional substring to filter by path or title."),
    },
    async ({ limit = 80, filter }) => {
      const corpus = await loadCombinedCorpus();
      if (!corpus) return { content: [{ type: "text", text: corpusMissing() }] };

      let list = listHelpArticles(corpus);

      if (filter) {
        const f = filter.toLowerCase();
        list = list.filter(
          a => a.path.toLowerCase().includes(f) || a.title.toLowerCase().includes(f)
        );
      }

      list = list.slice(0, limit);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: corpus.pages.length,
            returned: list.length,
            crawled_at: corpus.crawledAt,
            r: list.map(a => ({ p: a.path, t: a.title })),
          }),
        }],
      };
    }
  );

  return server;
}