import { timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";

export type McpOAuthClientCredentials = {
  clientId: string;
  clientSecret: string;
};

function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * Reads MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET when both are non-empty.
 * Partial config logs a warning and returns undefined.
 */
export function getMcpOAuthClientCredentials(): McpOAuthClientCredentials | undefined {
  const clientId = process.env.MCP_OAUTH_CLIENT_ID?.trim();
  const clientSecret = process.env.MCP_OAUTH_CLIENT_SECRET?.trim();
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    console.warn(
      "MCP_OAUTH_CLIENT_ID and MCP_OAUTH_CLIENT_SECRET must both be set to enable /mcp Basic auth; ignoring partial config."
    );
    return undefined;
  }
  return { clientId, clientSecret };
}

function parseBasicAuth(authorization: string | undefined): { user: string; pass: string } | undefined {
  if (!authorization?.startsWith("Basic ")) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(authorization.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return undefined;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/**
 * When mounted on `/mcp`, requires `Authorization: Basic base64(clientId:clientSecret)`.
 */
export function mcpOAuthBasicAuthMiddleware(creds: McpOAuthClientCredentials): RequestHandler {
  return (req, res, next) => {
    const parsed = parseBasicAuth(req.headers.authorization);
    if (
      !parsed ||
      !constantTimeEqual(parsed.user, creds.clientId) ||
      !constantTimeEqual(parsed.pass, creds.clientSecret)
    ) {
      res.setHeader("WWW-Authenticate", 'Basic realm="mcp"');
      res.status(401).send("Unauthorized");
      return;
    }
    next();
  };
}
