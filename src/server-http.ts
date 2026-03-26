import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { randomUUID } from "node:crypto";
import { createRivyoMcpServer } from "./createRivyoMcpServer.js";

type Session = {
  transport: StreamableHTTPServerTransport;
  server: McpServer;
};

const sessions = new Map<string, Session>();

const host = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
const port = Number(process.env.MCP_HTTP_PORT ?? process.env.PORT ?? 3333);

const extraHosts = (process.env.MCP_ALLOWED_HOSTS ?? "")
  .split(",")
  .map(h => h.trim())
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

app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

app.post("/mcp", async (req: Request, res: Response) => {
  const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;

  try {
    const existing = sessionIdHeader ? sessions.get(sessionIdHeader) : undefined;
    if (existing) {
      await existing.transport.handleRequest(req, res, req.body);
      return;
    }

    if (!sessionIdHeader && isInitializeRequest(req.body)) {
      const server = createRivyoMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: sid => {
          sessions.set(sid, { transport, server });
        },
      });

      transport.onclose = async () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
        await server.close().catch(() => {});
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
      return;
    }

    res.status(400).json({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Bad Request: No valid session ID provided",
      },
      id: null,
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

app.get("/mcp", async (req: Request, res: Response) => {
  const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionIdHeader || !sessions.has(sessionIdHeader)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const { transport } = sessions.get(sessionIdHeader)!;
  await transport.handleRequest(req, res);
});

app.delete("/mcp", async (req: Request, res: Response) => {
  const sessionIdHeader = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionIdHeader || !sessions.has(sessionIdHeader)) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  const { transport } = sessions.get(sessionIdHeader)!;
  await transport.handleRequest(req, res);
});

const httpServer = app.listen(port, host, () => {
  console.log(`Rivyo MCP (Streamable HTTP) at http://${host}:${port}/mcp`);
  console.log(`Health check: http://${host}:${port}/health`);
});

httpServer.on("error", err => {
  console.error("Failed to start:", err);
  process.exit(1);
});
