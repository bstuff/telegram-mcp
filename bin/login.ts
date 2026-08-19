#!/usr/bin/env node
// Interactive login: signs in to Telegram and stores the session string so the
// MCP server can connect without any credentials in the source tree.
//
//   node bin/login.ts            sign in (or re-auth) and save the session
//   node bin/login.ts --check    verify the stored session works
//   node bin/login.ts --import   save a session string you already have

import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { entityName } from "../src/client.ts";
import { config, readSession, writeSession } from "../src/config.ts";

const args = new Set(process.argv.slice(2));
const rl = readline.createInterface({ input, output });
const ask = (q: string): Promise<string> => rl.question(q);

/**
 * Prompts without echoing — for the 2FA password, which would otherwise sit in
 * the terminal scrollback. Falls back to a normal prompt when stdin is piped,
 * where there is nothing to hide anyway.
 */
function askSecret(prompt: string): Promise<string> {
  if (!input.isTTY) return ask(prompt);

  rl.pause();
  output.write(prompt);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  return new Promise<string>((resolve, reject) => {
    let value = "";
    const finish = (fn: () => void) => {
      input.off("data", onData);
      input.setRawMode(wasRaw);
      output.write("\n");
      rl.resume();
      fn();
    };
    const onData = (chunk: Buffer) => {
      for (const ch of chunk.toString("utf8")) {
        switch (ch) {
          case "\r":
          case "\n":
            finish(() => resolve(value));
            return;
          case "\u0003": // Ctrl-C
            finish(() => reject(new Error("Interrupted")));
            return;
          case "\u007f":
          case "\b":
            value = value.slice(0, -1);
            break;
          default:
            value += ch;
        }
      }
    };
    input.on("data", onData);
  });
}

/**
 * Reads the session string to import. Piped input is consumed whole rather
 * than line-wise: session files carry no trailing newline, and readline would
 * wait forever for one and then exit silently.
 */
async function readImportedSession(): Promise<string> {
  if (input.isTTY) return (await ask("Paste the session string: ")).trim();
  const chunks: Buffer[] = [];
  for await (const chunk of input) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Connects with the given session and reports who it belongs to. */
async function verify(apiId: number, apiHash: string, session: string): Promise<boolean> {
  const client = new TelegramClient(new StringSession(session), apiId, apiHash, {
    connectionRetries: 3,
  });
  try {
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      console.error("Session is not authorized.");
      return false;
    }
    const me = await client.getMe();
    console.log(`OK — signed in as ${entityName(me)} (@${me.username || "no username"}, id ${me.id}).`);
    return true;
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function main(): Promise<void> {
  let apiId = config.apiId;
  let apiHash = config.apiHash;

  if (!apiId || !apiHash) {
    console.log("Get api_id / api_hash at https://my.telegram.org → API development tools.\n");
    apiId = Number(await ask("api_id: "));
    apiHash = (await ask("api_hash: ")).trim();
  }

  if (args.has("--import")) {
    const session = await readImportedSession();
    if (!session) throw new Error("Empty session string — nothing to import.");
    // Verify before writing: a bad paste must not clobber a working session.
    if (!(await verify(apiId, apiHash, session))) {
      console.error("Session string rejected — the existing session was left untouched.");
      process.exitCode = 1;
      return;
    }
    console.log(`Saved to ${writeSession(session)}`);
    return;
  }

  if (args.has("--check")) {
    const session = readSession();
    if (!session) {
      console.error(`No session found (checked $TELEGRAM_SESSION and ${config.sessionFile}).`);
      process.exitCode = 1;
      return;
    }
    if (!(await verify(apiId, apiHash, session))) {
      console.error("Run `npm run login` to sign in again.");
      process.exitCode = 1;
    }
    return;
  }

  // Keeping the concrete StringSession means save() is typed as string.
  const session = new StringSession(readSession());
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });

  await client.start({
    phoneNumber: () => ask("Phone number (+7…): "),
    password: () => askSecret("2FA password (hidden): "),
    phoneCode: () => ask("Code from Telegram: "),
    onError: (err: Error) => console.error(err.message || err),
  });

  const me = await client.getMe();
  const file = writeSession(session.save());
  console.log(`\nSigned in as ${entityName(me)} (id ${me.id}).`);
  console.log(`Session saved to ${file} (mode 600).`);
  console.log(
    "\nAdd this to the MCP client config, or put TELEGRAM_API_ID / TELEGRAM_API_HASH in .env next to this repo."
  );
  await client.disconnect();
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  rl.close();
  process.exit(process.exitCode ?? 0);
}
