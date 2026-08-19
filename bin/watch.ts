#!/usr/bin/env node
// Blocks until a matching Telegram message arrives, prints it, and exits —
// so an agent can background it and be woken by the process exit, the same way
// it waits on a CI run.
//
//   node bin/watch.ts --chat "Team standup" --timeout 600
//   node bin/watch.ts --chat @somegroup --from @someone --contains "deployed"
//   node bin/watch.ts --to-me --timeout 1800        # mentions and replies to me, any chat
//   node bin/watch.ts --chat -1001234567890 --count 3 --json
//
// Exit codes: 0 matched, 2 timed out, 1 error.

import { NewMessage } from "teleproto/events/index.js";
import type { NewMessageEvent } from "teleproto/events/NewMessage.js";
import { disconnect, getClient, getMe, resolveChat } from "../src/client.ts";
import { formatMessage, senderName } from "../src/format.ts";
import type { Message } from "../src/format.ts";

interface Options {
  chat?: string;
  from?: string;
  contains?: string;
  regex?: string;
  toMe: boolean;
  count: number;
  timeout: number;
  json: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = { toMe: false, count: 1, timeout: 600, json: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case "--chat":
        opts.chat = next();
        break;
      case "--from":
        opts.from = next();
        break;
      case "--contains":
        opts.contains = next();
        break;
      case "--regex":
        opts.regex = next();
        break;
      case "--to-me":
        opts.toMe = true;
        break;
      case "--count":
        opts.count = Number(next());
        break;
      case "--timeout":
        opts.timeout = Number(next());
        break;
      case "--json":
        opts.json = true;
        break;
      case "--help":
      case "-h":
        console.log(HELP);
        process.exit(0);
      // eslint-disable-next-line no-fallthrough
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error("--timeout must be a positive number");
  if (!Number.isInteger(opts.count) || opts.count <= 0) throw new Error("--count must be a positive integer");
  return opts;
}

const HELP = `Wait for a Telegram message, then exit.

  --chat <ref>       Watch one chat (id, @username, title fragment, "me"). Omit to watch everything.
  --from <ref>       Only messages from this sender.
  --contains <text>  Only messages containing this text (case-insensitive).
  --regex <re>       Only messages matching this regular expression.
  --to-me            Only messages that mention me or reply to my message.
  --count <n>        Wait for n matches instead of 1 (default 1).
  --timeout <sec>    Give up after this many seconds (default 600).
  --json             Print each match as a JSON line instead of a formatted line.

Exit codes: 0 matched, 2 timed out, 1 error.`;

const opts = parseArgs(process.argv.slice(2));

// stdout carries only matches (one per line, parseable with --json), so teleproto
// and our own progress chatter are pushed to stderr.
const emit = (line: string) => process.stdout.write(`${line}\n`);
console.log = (...args: unknown[]) => console.error(...args);

const client = await getClient();
const me = await getMe();

const target = opts.chat ? await resolveChat(opts.chat) : undefined;
const fromId = opts.from ? (await resolveChat(opts.from)).entity.id.toString() : undefined;
const needle = opts.contains?.toLowerCase();
const pattern = opts.regex ? new RegExp(opts.regex, "i") : undefined;

function matches(message: Message): boolean {
  if (fromId && message.senderId?.toString() !== fromId) return false;
  if (opts.toMe && !message.mentioned && message.senderId?.toString() !== me.id.toString()) {
    // `mentioned` is set by Telegram both for @-mentions and replies to my messages.
    if (!message.mentioned) return false;
  }
  const text = message.message || "";
  if (needle && !text.toLowerCase().includes(needle)) return false;
  if (pattern && !pattern.test(text)) return false;
  return true;
}

const scope = target ? `"${target.title}" (${target.id})` : "all chats";
console.error(
  `watching ${scope} for ${opts.count} message(s), timeout ${opts.timeout}s` +
    [
      opts.from ? `, from ${opts.from}` : "",
      opts.contains ? `, containing "${opts.contains}"` : "",
      opts.regex ? `, matching /${opts.regex}/` : "",
      opts.toMe ? ", addressed to me" : "",
    ].join("")
);

let seen = 0;
const done = Promise.withResolvers<number>();

const handler = async (event: NewMessageEvent) => {
  const message = event.message as Message;
  if (!message || !matches(message)) return;
  seen += 1;
  if (opts.json) {
    emit(
      JSON.stringify({
        id: message.id,
        chat_id: target?.id ?? message.chatId?.toString(),
        date: new Date(message.date * 1000).toISOString(),
        sender: await senderName(message),
        sender_id: message.senderId?.toString(),
        reply_to: message.replyTo?.className === "MessageReplyHeader" ? message.replyTo.replyToMsgId : undefined,
        text: message.message,
      })
    );
  } else {
    emit(await formatMessage(message));
  }
  if (seen >= opts.count) done.resolve(0);
};

client.addEventHandler(handler, new NewMessage(target ? { chats: [target.entity.id] } : {}));

const timer = setTimeout(() => done.resolve(2), opts.timeout * 1000);
const code = await done.promise;
clearTimeout(timer);

if (code === 2) console.error(`timed out after ${opts.timeout}s with ${seen} match(es)`);
await disconnect();
process.exit(code);
