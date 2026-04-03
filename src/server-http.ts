import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { Request, Response } from "express";
import { createRivyoMcpServer } from "./createRivyoMcpServer.js";

const host = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? 3333);

const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((h) => h.trim())
  .filter(Boolean);

const app =
  extraHosts.length > 0
    ? createMcpExpressApp({
        host,
        allowedHosts: [
          "localhost",
          "127.0.0.1",
          "[::1]",
          ...extraHosts,
        ],
      })
    : createMcpExpressApp({ host });

// ── Health check ────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// ── Stateless MCP handler (required for Claude.ai) ──────────────
//
// Claude.ai does NOT send an initialize handshake before tool calls,
// so session-based routing always returns 400 "Invalid or missing session ID".
// Stateless mode (sessionIdGenerator: undefined) creates a fresh server
// instance per request — no session state needed.
//
app.post("/mcp", async (req: Request, res: Response) => {
  try {
    const server = createRivyoMcpServer();

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // ← stateless: fixes the 400 error
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    // Clean up after response is sent
    res.on("finish", () => {
      server.close().catch(() => {});
    });
  } catch (err) {
    console.error("MCP POST error:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error",
        },
        id: null,
      });
    }
  }
});

// ── Start ────────────────────────────────────────────────────────
const httpServer = app.listen(port, host, () => {
  console.log(`✅ Rivyo MCP running at http://${host}:${port}/mcp`);
  console.log(`❤️  Health check:   http://${host}:${port}/health`);
  if (extraHosts.length > 0) {
    console.log(`🌐 Allowed hosts:  ${extraHosts.join(", ")}`);
  }
});

httpServer.on("error", (err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});