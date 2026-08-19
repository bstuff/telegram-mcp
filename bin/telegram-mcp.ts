#!/usr/bin/env node
// Telegram MCP server (stdio transport).
//
// stdout is reserved for JSON-RPC — teleproto and anything else that logs must go
// to stderr, so console.log is redirected before any other module loads.
console.log = (...args: unknown[]) => console.error(...args);
console.info = (...args: unknown[]) => console.error(...args);
console.debug = () => {};

const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
const { createServer } = await import("../src/server.ts");
const { disconnect } = await import("../src/client.ts");

const server = createServer();
await server.connect(new StdioServerTransport());

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await disconnect().catch(() => {});
  await server.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.stdin.on("close", () => void shutdown());
