import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import type { HelpCorpus, HelpPageRecord } from "./helpTypes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = path.join(__dirname, "..", "knowledge", "help-corpus.json");

/** Chunk size for indexing (larger = more context per hit before optional clip). */
const CHUNK_TARGET = 580;

/** Default max chars per excerpt in tool JSON (raise via search_help excerpt_max_chars). */
export const HELP_EXCERPT_MAX_CHARS = 720;

export function clipHelpText(text: string, maxChars: number = HELP_EXCERPT_MAX_CHARS): string {
  const t = text.trim();
  if (t.length <= maxChars) return t;
  return `${t.slice(0, Math.max(0, maxChars - 1))}…`;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "must",
  "can",
  "how",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "this",
  "that",
  "these",
  "those",
  "it",
  "its",
  "we",
  "you",
  "your",
  "my",
  "me",
  "i",
  "they",
  "them",
  "their",
  "from",
  "with",
  "as",
  "by",
  "about",
  "into",
  "through",
  "during",
  "before",
  "after",
  "above",
  "below",
  "up",
  "down",
  "out",
  "off",
  "over",
  "under",
  "again",
  "then",
  "once",
  "here",
  "there",
  "all",
  "each",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "no",
  "nor",
  "not",
  "only",
  "own",
  "same",
  "so",
  "than",
  "too",
  "very",
  "just",
  "also",
  "now",
]);

let cached: { mtimeMs: number; corpus: HelpCorpus } | null = null;

function chunkPageText(text: string): string[] {
  const sentences = text.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    const next = cur ? `${cur} ${s}` : s;
    if (next.length > CHUNK_TARGET && cur) {
      chunks.push(cur.trim());
      cur = s;
    } else {
      cur = next;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length > 0 ? chunks : [text.slice(0, CHUNK_TARGET * 2)];
}

function tokenizeQuery(query: string): string[] {
  const raw = query
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const terms = raw.filter(w => w.length >= 2 && !STOPWORDS.has(w));
  if (terms.length > 0) return [...new Set(terms)];
  const fallback = query.toLowerCase().trim();
  if (fallback.length >= 3) return [fallback];
  return [];
}

/** Exported for markdown KB search (same token rules as help corpus). */
export function helpQueryTerms(query: string): string[] {
  return tokenizeQuery(query.trim());
}

function docFrequencyForTerms(pages: HelpPageRecord[], terms: string[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const t of terms) df.set(t, 0);
  for (const page of pages) {
    const blob = `${page.title}\n${page.path}\n${page.text}`.toLowerCase();
    for (const t of terms) {
      if (blob.includes(t)) df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  return df;
}

function idfWeight(nDocs: number, df: number): number {
  return Math.log((nDocs + 1) / (df + 1)) + 1;
}

export type HelpSearchHit = {
  path: string;
  url: string;
  title: string;
  excerpt: string;
  score: number;
  matchedTerms: string[];
  phraseMatch: boolean;
};

export function searchHelpStructured(
  corpus: HelpCorpus,
  query: string,
  options: { limit?: number; maxPerPath?: number } = {}
): HelpSearchHit[] {
  const limit = options.limit ?? 8;
  const maxPerPath = options.maxPerPath ?? 2;

  const qRaw = query.trim();
  if (!qRaw) return [];

  const queryLower = qRaw.toLowerCase();
  const terms = tokenizeQuery(qRaw);
  const pages = corpus.pages;
  const nDocs = Math.max(pages.length, 1);
  const dfMap = docFrequencyForTerms(pages, terms);
  const idf = (t: string) => idfWeight(nDocs, dfMap.get(t) ?? 0);

  const candidates: HelpSearchHit[] = [];

  for (const page of pages) {
    const chunks = chunkPageText(page.text);
    const titleLow = page.title.toLowerCase();
    const pathLow = page.path.toLowerCase().replace(/-/g, " ");

    for (const chunk of chunks) {
      const chunkLow = chunk.toLowerCase();
      let score = 0;
      const matchedTerms: string[] = [];
      let phraseMatch = false;

      if (queryLower.length >= 3 && chunkLow.includes(queryLower)) {
        phraseMatch = true;
        score += 12 + (chunkLow.split(queryLower).length - 1) * 3;
      }

      for (const t of terms) {
        if (!chunkLow.includes(t)) continue;
        matchedTerms.push(t);
        const w = idf(t);
        const tf = Math.min(chunkLow.split(t).length - 1, 4);
        score += w * (2 + tf);
      }

      for (const t of terms) {
        if (titleLow.includes(t)) score += idf(t) * 2;
        if (pathLow.includes(t)) score += 1.2;
      }

      if (terms.length === 0 && queryLower.length >= 3 && chunkLow.includes(queryLower)) {
        phraseMatch = true;
        score += 8;
      }

      const minScore =
        terms.length >= 3
          ? 6
          : terms.length === 2
            ? 5
            : terms.length === 1
              ? 4
              : queryLower.length >= 3
                ? 5
                : 99;

      if (score < minScore && !phraseMatch) continue;
      if (terms.length >= 2 && matchedTerms.length < 1 && !phraseMatch) continue;

      candidates.push({
        path: page.path,
        url: page.url,
        title: page.title,
        excerpt: chunk,
        score,
        matchedTerms: [...new Set(matchedTerms)],
        phraseMatch,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score);

  const perPath = new Map<string, number>();
  const out: HelpSearchHit[] = [];
  for (const h of candidates) {
    const c = perPath.get(h.path) ?? 0;
    if (c >= maxPerPath) continue;
    perPath.set(h.path, c + 1);
    out.push(h);
    if (out.length >= limit) break;
  }

  return out;
}

export async function loadHelpCorpus(): Promise<HelpCorpus | null> {
  try {
    const stat = await fs.stat(CORPUS_PATH);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.corpus;
    const raw = await fs.readFile(CORPUS_PATH, "utf-8");
    const corpus = JSON.parse(raw) as HelpCorpus;
    if (!corpus.pages || !Array.isArray(corpus.pages)) return null;
    cached = { mtimeMs: stat.mtimeMs, corpus };
    return corpus;
  } catch {
    return null;
  }
}

/** Legacy shape for merging into search_rivyo. */
export function searchHelpCorpus(
  corpus: HelpCorpus,
  query: string,
  options: { limit?: number; weight?: number; maxPerPath?: number } = {}
): { text: string; score: number; source: string }[] {
  void options.weight;
  const hits = searchHelpStructured(corpus, query, {
    limit: options.limit ?? 6,
    maxPerPath: options.maxPerPath ?? 2,
  });
  return hits.map(h => ({
    text: `${h.url} | ${h.title}\n${clipHelpText(h.excerpt, HELP_EXCERPT_MAX_CHARS)}`,
    score: h.score,
    source: `help:${h.path}`,
  }));
}

export function buildGroundedHelpResponse(
  corpus: HelpCorpus,
  query: string,
  hits: HelpSearchHit[],
  excerptMaxChars: number = HELP_EXCERPT_MAX_CHARS
): string {
  const cap = Math.max(200, Math.min(excerptMaxChars, 20_000));
  return JSON.stringify({
    note: "Answer only from e; cite u. If e is not enough, get_help_article(p)—do not invent steps or settings.",
    crawled_at: corpus.crawledAt,
    q: query.trim(),
    r: hits.map(h => ({
      p: h.path,
      u: h.url,
      t: h.title,
      e: clipHelpText(h.excerpt, cap),
    })),
  });
}

export function getHelpArticleByPath(
  corpus: HelpCorpus,
  articlePath: string
): HelpPageRecord | null {
  let p = articlePath.trim();
  if (!p.startsWith("/")) p = `/${p}`;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return corpus.pages.find(page => page.path === p) ?? null;
}

export function listHelpArticles(corpus: HelpCorpus): { path: string; title: string }[] {
  return corpus.pages.map(({ path, title }) => ({ path, title }));
}

export function corpusMissingMessage(): string {
  return "No help-corpus.json — run: npm run crawl:help";
}
