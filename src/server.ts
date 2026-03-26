import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRivyoMcpServer } from "./createRivyoMcpServer.js";

async function main() {
  const server = createRivyoMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main();
