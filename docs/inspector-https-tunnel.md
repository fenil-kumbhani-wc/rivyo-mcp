# MCP Inspector over HTTPS (two Dev Tunnels)

The Inspector serves **two** TCP ports on your machine:

| Port (default) | Role |
|----------------|------|
| **6274** | Web UI (what you open in the browser) |
| **6277** | MCP proxy API (`/health`, `/stdio`, `/sse`, `/mcp`, …) |

If you only tunnel **6274**, the page loads but calls like `https://<ui-host>:6277/health` fail (nothing is listening on the public internet on that port). You need a **second tunnel** for **6277**, then tell the UI where the proxy lives.

## 1. Start Inspector locally

**Command Prompt:**

```bat
set DANGEROUSLY_OMIT_AUTH=true
npx @modelcontextprotocol/inspector
```

**PowerShell:**

```powershell
$env:DANGEROUSLY_OMIT_AUTH = "true"
npx @modelcontextprotocol/inspector
```

Optional: attach Rivyo over stdio (same as `npm run server:inspect`):

```bat
set DANGEROUSLY_OMIT_AUTH=true
npx @modelcontextprotocol/inspector -- tsx ./src/server.ts
```

If **6274** or **6277** are busy, set custom ports before starting (example):

```bat
set CLIENT_PORT=8080
set SERVER_PORT=8081
set DANGEROUSLY_OMIT_AUTH=true
npx @modelcontextprotocol/inspector
```

Use those ports in the tunnels below instead of 6274/6277.

## 2. Create two Dev Tunnels

Using the Dev Tunnels CLI or Visual Studio / VS Code “Port Forwarding”:

1. **Tunnel A** → `localhost:6274` (Inspector UI).
2. **Tunnel B** → `localhost:6277` (MCP proxy).

You will get two HTTPS URLs, for example:

- UI: `https://abc-6274.inc1.devtunnels.ms`
- Proxy: `https://xyz-6277.inc1.devtunnels.ms`

## 3. Point the UI at the proxy

Pick **one** of these.

### A. Inspector Configuration (persistent)

1. Open the **UI** URL (Tunnel A) in the browser.
2. Open **Configuration** (gear / settings).
3. Set **MCP Proxy Full Address** to the **proxy** base URL only — no path, no `:6277` on the URL (the tunnel already terminates TLS on 443):

   `https://xyz-6277.inc1.devtunnels.ms`

4. Save / apply, then connect as usual.

### B. Query parameter (bookmark / shareable link)

The client reads config from the URL. You can bake in the proxy address (must be URL-encoded):

```text
https://abc-6274.inc1.devtunnels.ms/?MCP_PROXY_FULL_ADDRESS=https%3A%2F%2Fxyz-6277.inc1.devtunnels.ms
```

Replace both hosts with your real tunnel URLs.

## 4. Rivyo over Streamable HTTP (optional)

Remote MCP to Rivyo does **not** go through the Inspector proxy ports. Run:

```bat
npm run server:http
```

Tunnel **that** port (default **3333**) separately. In Inspector, choose **Streamable HTTP** and set the server URL to:

```text
https://<your-rivyo-tunnel-host>/mcp
```

## Troubleshooting

- **`Failed to fetch` / proxy health errors** — Proxy tunnel missing, wrong **MCP Proxy Full Address**, or typo (http vs https).
- **Different hostnames** — Allowed: the proxy enables CORS broadly; UI and proxy can be on different tunnel URLs if **MCP Proxy Full Address** is set correctly.
- **Auth** — Local dev often uses `DANGEROUSLY_OMIT_AUTH=true`; do not use that in production.
