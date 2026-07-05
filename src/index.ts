import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { HerdrClient } from "./herdr-client.js";
import { registerHerdrTools } from "./tools.js";

async function main(): Promise<void> {
  const client = new HerdrClient(
    process.env["HERDR_SOCKET"] ? { socketPath: process.env["HERDR_SOCKET"] } : {},
  );

  const server = new McpServer({ name: "herdr", version: "1.0.0" });
  registerHerdrTools(server, client);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("herdr-mcp: ready on stdio\n");

  const shutdown = (): void => {
    client.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  process.stderr.write(`herdr-mcp: fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
