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
  corpusMissingMessage,
  getHelpArticleByPath,
  helpQueryTerms,
  listHelpArticles,
  loadHelpCorpus,
  searchHelpCorpus,
  searchHelpStructured,
} from "./help/helpCorpus.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

async function readKnowledge(filename: string): Promise<string> {
  const filePath = path.join(KNOWLEDGE_DIR, filename);
  return await fs.readFile(filePath, "utf-8");
}

function getSmartFallback(query: string): string {
  return `No match for "${query}". Try: pricing, reviews/loyalty, vs Yotpo, integrations, or search_help.`;
}

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace("price", "pricing")
    .replace("cost", "pricing")
    .replace("plan", "pricing")
    .replace("review", "reviews");
}

function termInLine(lineLower: string, term: string): boolean {
  if (term.length <= 4) {
    const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`\\b${esc}\\b`, "i").test(lineLower);
  }
  return lineLower.includes(term);
}

async function searchAllKnowledge(query: string): Promise<string> {
  const sources = [
    { file: "pricing.md", weight: 3 },
    { file: "faq.md", weight: 2 },
    { file: "app.md", weight: 2 },
    { file: "competitors.md", weight: 1 },
  ];

  const queryLower = normalizeQuery(query).trim();
  const terms = helpQueryTerms(query);

  const [fileChunks, helpCorpus] = await Promise.all([
    Promise.all(
      sources.map(async ({ file, weight }) => {
        const content = await readKnowledge(file);
        const lines = content.split("\n");
        const local: { text: string; score: number }[] = [];

        for (let i = 0; i < lines.length; i++) {
          const lineRaw = lines[i];
          const lineLow = lineRaw.toLowerCase();

          let matchScore = 0;
          if (terms.length > 0) {
            const matched = terms.filter(t => termInLine(lineLow, t));
            if (matched.length === 0) continue;
            matchScore = matched.length;
            if (queryLower.length >= 3 && lineLow.includes(queryLower)) {
              matchScore += 3;
            }
          } else if (queryLower.length >= 3 && lineLow.includes(queryLower)) {
            matchScore = 1;
          } else {
            continue;
          }

          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length - 1, i + 2);
          const snippet = lines.slice(start, end + 1).join("\n");

          local.push({
            text: `### From ${file}:\n${snippet}`,
            score: weight + matchScore,
          });
        }

        return local;
      })
    ),
    loadHelpCorpus(),
  ]);

  const results = fileChunks.flat();

  if (helpCorpus) {
    for (const hit of searchHelpCorpus(helpCorpus, query, { limit: 6, maxPerPath: 2 })) {
      results.push({ text: hit.text, score: hit.score });
    }
  }

  if (results.length === 0) {
    return getSmartFallback(query);
  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, 6).map(r => r.text).join("\n\n");
}

export function createRivyoMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "rivyo-internal-dev",
      version: "1.0.0",
    },
    {
      instructions:
        "Internal dev MCP. For help docs: search_help first; if excerpts are incomplete for the question, call get_help_article(p) for full page—never guess UI steps. Cite u. JSON uses short keys (p,u,t,e). Corpus is a crawl snapshot.",
    }
  );

  server.tool(
    "search_rivyo",
    "[Internal dev] Search markdown KB plus ranked help excerpts (same retrieval as search_help when help-corpus.json exists).",
    {
      query: z.string(),
    },
    async ({ query }) => {
      try {
        const result = await searchAllKnowledge(query);
        const text =
          typeof result === "string" && result.trim().length > 0
            ? result
            : getSmartFallback(query);
        return { content: [{ type: "text", text }] };
      } catch (err) {
        const code =
          err && typeof err === "object" && "code" in err
            ? String((err as { code?: string }).code)
            : "";
        const msg =
          code === "ENOENT"
            ? "ENOENT: use tsx ./src/server.ts from repo root or copy src/knowledge → build/knowledge."
            : "Search failed.";
        return { content: [{ type: "text", text: msg }] };
      }
    }
  );

  server.tool(
    "get_pricing",
    "[Internal dev] Read pricing.md from the internal knowledge bundle.",
    {
      plan: z
        .enum([
          "all",
          "indie",
          "starter",
          "business",
          "enterprise",
          "referrals",
          "loyalty",
        ])
        .optional(),
    },
    async ({ plan = "all" }) => {
      try {
        const content = await readKnowledge("pricing.md");

        if (plan === "all") {
          return { content: [{ type: "text", text: content }] };
        }

        const lines = content.split("\n");
        const sectionLines: string[] = [];
        let inSection = false;

        for (const line of lines) {
          if (line.toLowerCase().startsWith(`## ${plan}`)) {
            inSection = true;
          } else if (line.startsWith("## ") && inSection) {
            break;
          }

          if (inSection) sectionLines.push(line);
        }

        const result =
          sectionLines.length > 0
            ? sectionLines.join("\n")
            : content;

        return { content: [{ type: "text", text: result }] };
      } catch {
        return {
          content: [{ type: "text", text: "Failed to get pricing." }],
        };
      }
    }
  );

  server.tool(
    "compare_competitors",
    "[Internal dev] Read competitor comparison notes from internal competitors.md.",
    {
      competitor: z.enum([
        "judge.me",
        "yotpo",
        "stamped",
        "loox",
        "okendo",
        "fera",
        "trustoo",
        "ryviu",
        "opinew",
        "reviews.io",
        "all",
      ]),
    },
    async ({ competitor }) => {
      try {
        const content = await readKnowledge("competitors.md");

        if (competitor === "all") {
          return { content: [{ type: "text", text: content }] };
        }

        const lines = content.split("\n");
        const sectionLines: string[] = [];
        let inSection = false;

        for (const line of lines) {
          if (
            line.toLowerCase().includes(`vs ${competitor}`) &&
            line.toLowerCase().startsWith("## rivyo vs")
          ) {
            inSection = true;
          } else if (line.startsWith("## ") && inSection) {
            break;
          }

          if (inSection) sectionLines.push(line);
        }

        const result =
          sectionLines.length > 0
            ? sectionLines.join("\n")
            : content;

        return { content: [{ type: "text", text: result }] };
      } catch {
        return {
          content: [{ type: "text", text: "Comparison failed." }],
        };
      }
    }
  );

  server.tool(
    "get_faq",
    "[Internal dev] Read internal FAQ markdown by topic.",
    {
      topic: z
        .enum([
          "general",
          "reviews",
          "loyalty",
          "referrals",
          "pricing",
          "technical",
          "all",
        ])
        .optional(),
    },
    async ({ topic = "all" }) => {
      try {
        const content = await readKnowledge("faq.md");

        if (topic === "all") {
          return { content: [{ type: "text", text: content }] };
        }

        const lines = content.split("\n");
        const sectionLines: string[] = [];
        let inSection = false;

        for (const line of lines) {
          if (line.toLowerCase().startsWith(`## ${topic}`)) {
            inSection = true;
          } else if (line.startsWith("## ") && inSection) {
            break;
          }

          if (inSection) sectionLines.push(line);
        }

        const result =
          sectionLines.length > 0
            ? sectionLines.join("\n")
            : content;

        return { content: [{ type: "text", text: result }] };
      } catch {
        return {
          content: [{ type: "text", text: "Failed to get FAQ." }],
        };
      }
    }
  );

  server.tool(
    "capture_lead",
    "[Internal dev only] Append a row to local leads.json for internal testing or demos—not a production CRM.",
    {
      name: z.string(),
      email: z.string().email(),
      store: z.string().optional(),
      message: z.string().optional()
    },
    async (params) => {
      const file = path.join(__dirname, "leads.json");

      let leads: unknown[] = [];
      try {
        const data = await fs.readFile(file, "utf-8");
        leads = JSON.parse(data) as unknown[];
      } catch { /* empty */ }

      leads.push({
        id: leads.length + 1,
        ...params,
        createdAt: new Date().toISOString()
      });

      await fs.writeFile(file, JSON.stringify(leads, null, 2));

      return {
        content: [{ type: "text", text: "Recorded in leads.json (internal test file)." }],
      };
    }
  );

  server.tool(
    "recommend_plan",
    "[Internal dev] Rough plan heuristic from order volume—verify against live pricing.",
    {
      orders_per_month: z.number(),
    },
    async ({ orders_per_month }) => {
      let plan = "Indie";

      if (orders_per_month > 1000) plan = "Enterprise";
      else if (orders_per_month > 500) plan = "Business";
      else if (orders_per_month > 100) plan = "Starter";

      return {
        content: [
          {
            type: "text",
            text: `Recommended plan: ${plan}`
          }
        ]
      };
    }
  );

  server.tool(
    "search_help",
    "[Internal dev] JSON {note,crawled_at,q,r:[{p,u,t,e}]}. excerpt_max_chars (200–20000) overrides e length; default ~720. Up to 6 hits, 2 per path. Use get_help_article(p) when e is not enough.",
    {
      query: z.string(),
      excerpt_max_chars: z.number().min(200).max(20_000).optional(),
    },
    async ({ query, excerpt_max_chars }) => {
      const corpus = await loadHelpCorpus();
      if (!corpus) {
        return { content: [{ type: "text", text: corpusMissingMessage() }] };
      }
      const structured = searchHelpStructured(corpus, query, { limit: 6, maxPerPath: 2 });
      if (structured.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                note: "No hits—try other terms, list_help_articles, or get_help_article if path known.",
                crawled_at: corpus.crawledAt,
                q: query.trim(),
                r: [],
              }),
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: buildGroundedHelpResponse(
              corpus,
              query,
              structured,
              excerpt_max_chars
            ),
          },
        ],
      };
    }
  );

  server.tool(
    "get_help_article",
    "[Internal dev] JSON {note,c,u,p,t,b}. Optional body_max_chars caps b (default full).",
    {
      path: z.string(),
      body_max_chars: z.number().min(800).max(100_000).optional(),
    },
    async ({ path: articlePath, body_max_chars }) => {
      const corpus = await loadHelpCorpus();
      if (!corpus) {
        return { content: [{ type: "text", text: corpusMissingMessage() }] };
      }
      const page = getHelpArticleByPath(corpus, articlePath);
      if (!page) {
        return {
          content: [
            {
              type: "text",
              text: `No article: ${articlePath}`,
            },
          ],
        };
      }
      const body =
        body_max_chars !== undefined
          ? clipHelpText(page.text, body_max_chars)
          : page.text;
      const payload = {
        note: "Default is full b for accuracy. body_max_chars only if you accept missing detail.",
        c: corpus.crawledAt,
        u: page.url,
        p: page.path,
        t: page.title,
        b: body,
        truncated: body_max_chars !== undefined && page.text.length > body.length,
      };
      return { content: [{ type: "text", text: JSON.stringify(payload) }] };
    }
  );

  server.tool(
    "list_help_articles",
    "[Internal dev] Compact JSON {n,r:[{p,t}…]}. limit caps r (default 60).",
    { limit: z.number().min(1).max(500).optional() },
    async ({ limit = 60 }) => {
      const corpus = await loadHelpCorpus();
      if (!corpus) {
        return { content: [{ type: "text", text: corpusMissingMessage() }] };
      }
      const list = listHelpArticles(corpus).slice(0, limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              n: corpus.pages.length,
              r: list.map(a => ({ p: a.path, t: a.title })),
            }),
          },
        ],
      };
    }
  );

  return server;
}
