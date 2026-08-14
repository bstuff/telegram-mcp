import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { config } from "../config.ts";

export type Shape = z.ZodRawShape;

export const text = (value: string): CallToolResult => ({ content: [{ type: "text", text: value }] });
export const fail = (value: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: value }],
});

export function formatError(err: unknown): string {
  if (!err) return "Unknown error";
  const e = err as { message?: string; errorMessage?: string; code?: number; seconds?: number };
  const code = e.errorMessage ?? e.code;
  if (e.seconds && String(code).startsWith("FLOOD_WAIT")) {
    return `Telegram rate limit: wait ${e.seconds}s before retrying.`;
  }
  const message = e.message ?? String(err);
  const detail = code && !message.includes(String(code)) ? ` (${code})` : "";
  return `${message}${detail}`;
}

export interface ToolConfig<S extends Shape> {
  title: string;
  description: string;
  inputSchema?: S;
  annotations?: ToolAnnotations;
}

/**
 * Registers a tool. Write tools (anything not marked read-only) are skipped
 * entirely when TELEGRAM_MCP_READ_ONLY is set.
 */
export function tool<S extends Shape>(
  server: McpServer,
  name: string,
  cfg: ToolConfig<S>,
  handler: (args: z.infer<z.ZodObject<S>>) => Promise<string | CallToolResult>
): void {
  const isWrite = !cfg.annotations?.readOnlyHint;
  if (isWrite && config.readOnly) return;

  const wrapped = async (args: unknown): Promise<CallToolResult> => {
    try {
      const result = await handler((args ?? {}) as z.infer<z.ZodObject<S>>);
      return typeof result === "string" ? text(result) : result;
    } catch (err) {
      return fail(formatError(err));
    }
  };

  // The SDK's generics don't line up with a wrapper this generic; the handler
  // body above is still fully typed through S.
  (server.registerTool as unknown as (n: string, c: unknown, h: unknown) => void)(name, cfg, wrapped);
}

/* Shared parameter shapes ------------------------------------------------ */

export const chatArg = z
  .string()
  .describe(
    "Chat: numeric id (-1001234567890), @username, t.me link, 'me' for Saved Messages, or part of the chat title."
  );

export const sinceArg = z
  .string()
  .optional()
  .describe("Start of the window: '7d', '36h', 'today', 'yesterday', '2026-07-17', or an ISO timestamp.");

export const untilArg = z
  .string()
  .optional()
  .describe("End of the window (same formats as `since`). Defaults to now.");

export const parseModeArg = z
  .enum(["none", "markdown", "markdown2", "html"])
  .default("none")
  .describe("How to interpret formatting in the text. 'none' sends it literally.");

export type ParseModeName = "none" | "markdown" | "markdown2" | "html";

/** GramJS takes `false` to mean "do not parse at all". */
export function parseModeValue(mode: ParseModeName): string | false {
  switch (mode) {
    case "markdown":
      return "md";
    case "markdown2":
      return "md2";
    case "html":
      return "html";
    default:
      return false;
  }
}

export const chatTypeArg = z.enum(["all", "user", "bot", "group", "channel"]).default("all");
export type ChatTypeFilter = "all" | "user" | "bot" | "group" | "channel";

export const TYPE_GROUPS: Record<Exclude<ChatTypeFilter, "all">, string[]> = {
  user: ["user"],
  bot: ["bot"],
  group: ["group", "supergroup", "broadcast_group"],
  channel: ["channel"],
};

export function pct(part: number, total: number): string {
  if (!total) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

export function bar(value: number, max: number, width = 20): string {
  if (!max || !value) return "";
  return "█".repeat(Math.max(1, Math.round((value / max) * width)));
}

export { z };
