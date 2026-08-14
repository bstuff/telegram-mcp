import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const HOME_DIR = process.env.TELEGRAM_MCP_HOME || path.join(os.homedir(), ".telegram-mcp");

// Minimal .env loader: real environment variables always win over file values.
function loadEnvFile(file: string): void {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.split(" #")[0]!.trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, ".env"));
loadEnvFile(path.join(HOME_DIR, ".env"));

const bool = (v: string | undefined, fallback = false): boolean =>
  v === undefined ? fallback : ["1", "true", "yes", "on"].includes(v.toLowerCase());

const num = (v: string | undefined, fallback: number): number =>
  v === undefined || v === "" ? fallback : Number(v);

export interface Config {
  apiId: number;
  apiHash: string;
  sessionFile: string;
  /** Disables every tool that writes to Telegram. */
  readOnly: boolean;
  /** Where download_media puts files by default. */
  downloadDir: string;
  /** How many dialogs to pull into the chat-resolution cache. */
  dialogLimit: number;
  /** Seconds before the dialog cache is refetched. */
  dialogTtl: number;
  /** Timezone used when rendering message timestamps. */
  timezone: string | undefined;
  /** Hard ceiling on messages a single read tool may pull. */
  maxMessages: number;
}

export const config: Config = {
  apiId: num(process.env.TELEGRAM_API_ID, 0),
  apiHash: process.env.TELEGRAM_API_HASH || "",
  sessionFile: process.env.TELEGRAM_SESSION_FILE || path.join(HOME_DIR, "session"),
  readOnly: bool(process.env.TELEGRAM_MCP_READ_ONLY),
  downloadDir: process.env.TELEGRAM_MCP_DOWNLOAD_DIR || path.join(HOME_DIR, "downloads"),
  dialogLimit: num(process.env.TELEGRAM_MCP_DIALOG_LIMIT, 400),
  dialogTtl: num(process.env.TELEGRAM_MCP_DIALOG_TTL, 120),
  timezone: process.env.TELEGRAM_MCP_TZ || undefined,
  maxMessages: num(process.env.TELEGRAM_MCP_MAX_MESSAGES, 3000),
};

export function readSession(): string {
  if (process.env.TELEGRAM_SESSION) return process.env.TELEGRAM_SESSION.trim();
  try {
    return fs.readFileSync(config.sessionFile, "utf8").trim();
  } catch {
    return "";
  }
}

export function writeSession(session: string): string {
  fs.mkdirSync(path.dirname(config.sessionFile), { recursive: true });
  fs.writeFileSync(config.sessionFile, session, { mode: 0o600 });
  return config.sessionFile;
}
