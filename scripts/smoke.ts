#!/usr/bin/env node
// Dev harness: drives the MCP server over stdio exactly like a real client.
//
//   node scripts/smoke.ts                                  list tools and prompts
//   node scripts/smoke.ts '[["whoami",{}]]'                call tools in order
//   node scripts/smoke.ts '[["get_history",{"chat":"…","since":"7d"}]]'
//
// Write tools hit the real account — clean up after yourself.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Call = [name: string, args: Record<string, unknown>];

const calls: Call[] = JSON.parse(process.argv[2] ?? "[]") as Call[];

const transport = new StdioClientTransport({
  command: "node",
  args: ["bin/telegram-mcp.ts"],
  cwd: process.cwd(),
  stderr: "pipe",
});

const client = new Client({ name: "smoke", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`TOOLS (${tools.length}): ${tools.map((t) => t.name).join(", ")}\n`);
const { prompts } = await client.listPrompts();
console.log(`PROMPTS: ${prompts.map((p) => p.name).join(", ")}\n`);

for (const [name, args] of calls) {
  const started = Date.now();
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as { type: string; text?: string }[];
  const body = content.map((c) => c.text ?? `<${c.type}>`).join("\n");
  const flag = res.isError ? " [ERROR]" : "";
  console.log(`\n===== ${name} ${JSON.stringify(args)} (${Date.now() - started}ms)${flag}`);
  console.log(body.length > 3000 ? `${body.slice(0, 3000)}\n… (${body.length} chars)` : body);
}

await client.close();
process.exit(0);
