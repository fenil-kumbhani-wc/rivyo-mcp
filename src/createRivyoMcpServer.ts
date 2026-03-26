import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const KNOWLEDGE_DIR = path.join(__dirname, "knowledge");

async function readKnowledge(filename: string): Promise<string> {
  const filePath = path.join(KNOWLEDGE_DIR, filename);
  return await fs.readFile(filePath, "utf-8");
}

function getSmartFallback(query: string): string {
  return `
No exact match found for "${query}".

Try asking:
- Pricing plans
- Features (reviews, loyalty, referrals)
- Competitor comparison (Rivyo vs Yotpo, Loox, etc.)
- Integrations (Klaviyo, Slack, etc.)

Example:
"What is Rivyo pricing?"
"Compare Rivyo vs Yotpo"
"Does Rivyo support loyalty points?"
`;
}

function normalizeQuery(query: string): string {
  return query
    .toLowerCase()
    .replace("price", "pricing")
    .replace("cost", "pricing")
    .replace("plan", "pricing")
    .replace("review", "reviews");
}

async function searchAllKnowledge(query: string): Promise<string> {
  const sources = [
    { file: "pricing.md", weight: 3 },
    { file: "faq.md", weight: 2 },
    { file: "app.md", weight: 2 },
    { file: "competitors.md", weight: 1 },
  ];

  const queryLower = normalizeQuery(query);
  const results: {
    text: string;
    score: number;
  }[] = [];

  await Promise.all(
    sources.map(async ({ file, weight }) => {
      const content = await readKnowledge(file);
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].toLowerCase();

        if (line.includes(queryLower)) {
          const start = Math.max(0, i - 2);
          const end = Math.min(lines.length - 1, i + 2);

          const snippet = lines.slice(start, end + 1).join("\n");

          const score = weight + (line.split(queryLower).length - 1);

          results.push({
            text: `### From ${file}:\n${snippet}`,
            score,
          });
        }
      }
    })
  );

  if (results.length === 0) {
    return getSmartFallback(query);
  }

  results.sort((a, b) => b.score - a.score);

  return results.slice(0, 5).map(r => r.text).join("\n\n");
}

export function createRivyoMcpServer(): McpServer {
  const server = new McpServer({
    name: "Rivyo",
    version: "1.0.0",
  });

  server.tool(
    "search_rivyo",
    "Search Rivyo knowledge base",
    {
      query: z.string(),
    },
    async ({ query }) => {
      try {
        const result = await searchAllKnowledge(query);
        return { content: [{ type: "text", text: result }] };
      } catch {
        return {
          content: [{ type: "text", text: "Search failed." }],
        };
      }
    }
  );

  server.tool(
    "get_pricing",
    "Get pricing details",
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
    "Compare Rivyo with competitors",
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
    "Get FAQ answers",
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
    "Capture potential customer lead",
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
        content: [
          { type: "text", text: "Lead captured successfully 🚀" }
        ]
      };
    }
  );

  server.tool(
    "recommend_plan",
    "Recommend best Rivyo plan based on store size",
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

  return server;
}
