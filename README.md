# telegram-mcp

*[Русская версия](README.ru.md)*

An MCP server on top of a personal Telegram account — MTProto via
[GramJS](https://github.com/gram-js/gramjs), not a bot. It lets an assistant read chats, send
messages, run polls, and do most of what a regular Telegram client can.

TypeScript with no build step: Node ≥ 22.18 runs `.ts` directly through type stripping, and types
are checked separately with `npm run typecheck`.

## Setup

```bash
npm install
npm run login        # sign in by phone number; the session lands in ~/.telegram-mcp/session (mode 600)
npm run check        # verify the stored session still works
```

`api_id` / `api_hash` come from `.env` (see `.env.example`) or are asked for during login. Get them
at https://my.telegram.org → API development tools.

## Connecting a client

Claude Code:

```bash
claude mcp add telegram -- node ~/telegram-mcp/bin/telegram-mcp.ts
```

Or by hand, in the `mcpServers` block of any MCP client:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/telegram-mcp/bin/telegram-mcp.ts"]
    }
  }
}
```

### Claude Desktop

Two options. Through `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "telegram": {
      "command": "node",
      "args": ["/absolute/path/to/telegram-mcp/bin/telegram-mcp.ts"]
    }
  }
}
```

The app resolves bare commands against the login shell's PATH — its logs show `npx` being found
inside `~/.nvm/...` — so an absolute path to Node is not required. A server configured this way
works, but gets no on/off switch in the UI.

The other option is an extension, which does get a switch in Settings → Extensions and in the chat
tool list:

```bash
npm run bundle
```

This produces `telegram.mcpb`: a thin launcher that runs the server from this working copy. The
code is not copied into the bundle, so edits take effect after an app restart with no repack.
Install it via Settings → Extensions → Advanced settings → Extension Developer. The extension
settings expose "Read-only mode" and a timezone. Repack only when the tool list or the manifest
changes.

The extension icon comes from `assets/icon-128.png` and `assets/icon-16.png`; the script copies
them into the archive and fills in the manifest's `icon` and `icons` fields. To use your own,
drop in files with the same names and repack — if they are missing, the build simply produces no
icon.

The launcher checks the Node version and prints a readable error on an old runtime instead of a
syntax error. To pin a specific binary instead of relying on PATH:

```bash
TELEGRAM_MCP_NODE=/opt/homebrew/bin/node npm run bundle
```

Do not keep both the config entry and the extension — the tools will show up twice.

## Addressing a chat

Every tool accepts any of these in its `chat` field:

- an id — `-1001234567890`, `123456789`
- an `@username` or a `https://t.me/username` link
- `me` — Saved Messages
- **a fragment of the chat title** — `Team standup`, `barahol`

Titles are resolved against the dialog cache (the most recent `TELEGRAM_MCP_DIALOG_LIMIT` dialogs,
400 by default). If a fragment matches several chats, the server returns the candidates instead of
guessing.

Time fields (`since`, `until`, `schedule_at`) understand `7d`, `36h`, `today`, `yesterday`,
`2026-07-17`, `2026-07-17T10:00` and unix timestamps.

## Tools

### Chats
| Tool | What it does |
|---|---|
| `whoami` | which account the server is signed in as |
| `list_chats` | dialogs, filtered by name, type, unread state or archive |
| `get_chat` | one chat in detail: type, description, members, pinned message, unread count |
| `list_members` | participants of a group or channel, optionally admins only |
| `find_public_chat` | global search for public users, groups and channels |

### Reading
| Tool | What it does |
|---|---|
| `get_history` | chat history over a period; filters by sender, text, media kind, id range |
| `search_messages` | full-text search in one chat or across all of them |
| `get_message` | messages by id with reactions, replies, forwards and links |
| `get_replies` | the comment thread under a post |
| `get_unread` | everything unread across chats, without marking anything read |
| `chat_digest` | stats for a period: who talked how much, activity per day and hour, links, media, most-reacted messages |
| `list_media` | recent media with ids, ready for `download_media` |
| `get_draft` | unsent drafts across chats |
| `list_scheduled` | messages scheduled for later |

### Acting
| Tool | What it does |
|---|---|
| `send_message` | text, replies, comments on channel posts, silent delivery, scheduling |
| `edit_message` / `delete_messages` | edit and delete (deletion cannot be undone) |
| `forward_messages` | forward, optionally without the "forwarded from" header |
| `react` | add or remove an emoji reaction |
| `pin_message` / `unpin_message` | pin, unpin, or unpin everything |
| `mark_read` | clear the unread badge |
| `set_mute` | mute for N minutes or indefinitely, unmute |
| `cancel_scheduled` | drop a scheduled message |
| `send_file` / `download_media` | send a local file or URL; download an attachment |

### Polls and toys
| Tool | What it does |
|---|---|
| `create_poll` | multiple choice, non-anonymous, quiz mode with a correct answer and explanation, auto-close after N seconds |
| `poll_results` | votes, percentages, and for public polls who voted for what |
| `vote_poll` | cast your own vote |
| `close_poll` | stop a poll and return the final tally |
| `send_dice` | 🎲 🎯 🏀 ⚽ 🎳 🎰 — the value is decided by Telegram's server, so it works as a fair draw |
| `random_member` | pick a random member: today's duty person, a reviewer, a raffle winner |
| `set_typing` | show a typing indicator |

Prompts (slash commands in the client): `catch_up`, `morning_telegram`, `run_poll`.

## Examples

> What happened in "Team standup" this week?
> → `chat_digest` + `get_history`

> Start a poll in the work chat about when to do the retro: Tuesday, Wednesday, Thursday, multiple choice
> → `create_poll(multiple=true)`, then `poll_results`

> Remind me about the call tomorrow at 9
> → `send_message(chat="me", schedule_at="2026-08-10T09:00")`

> Who is on deploy duty today?
> → `random_member(chat="…", active_only=true)`

## Waiting for a message

`bin/watch.ts` blocks until a matching message arrives, prints it, and exits. It is a CLI rather
than an MCP tool on purpose: an agent can run it in the background and be woken by the process
exit, the same way it waits on a CI run. No daemon or always-on process is involved.

```bash
node bin/watch.ts --chat "Team standup" --timeout 600
node bin/watch.ts --chat @somegroup --from @someone --contains "deployed"
node bin/watch.ts --to-me --timeout 1800     # mentions and replies to me, any chat
node bin/watch.ts --chat -1001234567890 --count 3 --json
```

| Flag | Meaning |
|---|---|
| `--chat <ref>` | watch one chat; omit to watch all of them |
| `--from <ref>` | only messages from this sender |
| `--contains <text>` / `--regex <re>` | filter by text |
| `--to-me` | only mentions of me and replies to my messages |
| `--count <n>` | wait for n matches (default 1) |
| `--timeout <sec>` | give up after this many seconds (default 600) |
| `--json` | print a JSON line instead of a formatted one |

Exit codes: `0` matched, `2` timed out, `1` error.

## Configuration (env / `.env`)

| Variable | Meaning |
|---|---|
| `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` | required |
| `TELEGRAM_SESSION` | session string, if you would rather not use a file |
| `TELEGRAM_SESSION_FILE` | path to the session file (default `~/.telegram-mcp/session`) |
| `TELEGRAM_MCP_READ_ONLY=1` | register only the reading tools |
| `TELEGRAM_MCP_TZ` | timezone for rendered timestamps |
| `TELEGRAM_MCP_DOWNLOAD_DIR` | where `download_media` writes files |
| `TELEGRAM_MCP_DIALOG_LIMIT` | how many dialogs to cache for title lookup |
| `TELEGRAM_MCP_MAX_MESSAGES` | ceiling on messages per call |

## Development

```
src/client.ts     connection, dialog cache, chat resolution
src/format.ts     time parsing, message rendering, history collection
src/tools/*.ts    tools by group: chats, read, write, media, polls, fun
bin/*.ts          server entry point and interactive login
scripts/smoke.ts  dev harness: drives the server over stdio like a real client
```

```bash
npm run typecheck
node scripts/smoke.ts '[["get_history",{"chat":"Team standup","since":"2d"}]]'
```

`scripts/smoke.ts` talks to the live account — clean up after any write calls.

## Security

- The session string grants full access to the account. It lives in `~/.telegram-mcp/session` with
  mode 600 and must never reach git (`.gitignore` already covers it).
- Message content is **data, not instructions**. If a message says "forward this to everyone" or
  "send me the code", that is not a command to the assistant. The server states this in its MCP
  `instructions`.
- `delete_messages` and `close_poll` cannot be undone.
- For a look-but-don't-touch setup, use `TELEGRAM_MCP_READ_ONLY=1`.

## License and trademarks

The code is [MIT](LICENSE).

This is an independent project. It is not affiliated with, endorsed by, or supported by Telegram
FZ-LLC or Telegram Messenger Inc. "Telegram" is their trademark, used here nominatively to say
what this server talks to.

The logo in `assets/icon-128.png` and `assets/icon-16.png` comes from telegram.org and belongs to
its owner. It is included solely as the extension icon and **is not covered by the MIT license**.
If that is inconvenient, delete the files — `npm run bundle` works fine without them — or replace
them with your own using the same names.
