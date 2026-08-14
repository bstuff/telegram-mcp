import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api, dialogTitle, entityName, entityType, getClient, getDialogs, resolveChat } from "../client.ts";
import type { Message } from "../format.ts";
import {
  MESSAGE_FILTERS,
  collectMessages,
  dayKey,
  describeMessage,
  extractUrls,
  fmtDate,
  formatMessages,
  hourOf,
  mediaSummary,
  parseTime,
  peerId,
  reactionTotal,
  senderName,
  unix,
} from "../format.ts";
import type { Entity } from "../types.ts";
import { TYPE_GROUPS, bar, chatArg, chatTypeArg, pct, sinceArg, tool, untilArg, z } from "./helpers.ts";

const FILTER_NAMES = Object.keys(MESSAGE_FILTERS) as (keyof typeof MESSAGE_FILTERS)[];
const filterEnum = z.enum(["all", ...FILTER_NAMES] as [string, ...string[]]);

interface SenderStats {
  count: number;
  chars: number;
  reactions: number;
}

export function registerReadTools(server: McpServer): void {
  tool(
    server,
    "get_history",
    {
      title: "Read chat history",
      description:
        "Read messages from a chat within a time window. This is the main tool for 'what happened in chat X over the last week'. Returns messages oldest-first.",
      inputSchema: {
        chat: chatArg,
        since: sinceArg,
        until: untilArg,
        limit: z.number().int().min(1).max(3000).default(200).describe("Max messages to return."),
        from_user: z.string().optional().describe("Only messages from this user (id, @username, or 'me')."),
        search: z.string().optional().describe("Only messages containing this text."),
        filter: filterEnum.default("all").describe("Restrict to a media kind, links, pinned or mentions."),
        min_id: z.number().int().optional().describe("Only messages with a higher id."),
        max_id: z.number().int().optional().describe("Only messages with a lower id."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, since, until, limit, from_user, search, filter, min_id, max_id }) => {
      const { entity, title, id } = await resolveChat(chat);
      const fromUser = from_user ? (await resolveChat(from_user)).entity : undefined;

      let messages: Message[];
      if (min_id || max_id) {
        const client = await getClient();
        messages = [];
        for await (const m of client.iterMessages(entity, {
          minId: min_id ?? 0,
          maxId: max_id ?? 0,
          reverse: true,
          limit,
        })) {
          messages.push(m);
        }
      } else {
        messages = await collectMessages(entity, {
          since: parseTime(since, { label: "since" }),
          until: parseTime(until, { label: "until" }),
          limit,
          fromUser,
          search,
          filter: filter === "all" ? undefined : (filter as keyof typeof MESSAGE_FILTERS),
        });
      }

      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) return `No messages in "${title}" (${id}) for that window.`;

      const header = `"${title}" (${id}) — ${messages.length} messages, ${fmtDate(first.date)} → ${fmtDate(last.date)}`;
      // The window is walked newest-first, so hitting the limit means older messages were dropped.
      const truncated =
        messages.length >= limit && since
          ? `\n(limit of ${limit} reached — messages older than ${fmtDate(first.date)} were not returned)`
          : "";
      return `${header}${truncated}\n${await formatMessages(messages)}`;
    }
  );

  tool(
    server,
    "search_messages",
    {
      title: "Search messages",
      description: "Full-text search inside one chat, or across all chats when `chat` is omitted.",
      inputSchema: {
        query: z.string().describe("Text to search for."),
        chat: z.string().optional().describe("Limit the search to this chat. Omit to search everywhere."),
        limit: z.number().int().min(1).max(200).default(50),
        since: sinceArg,
        until: untilArg,
        from_user: z.string().optional().describe("Only messages from this user (single-chat search only)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, chat, limit, since, until, from_user }) => {
      const sinceDate = parseTime(since, { label: "since" });
      const untilDate = parseTime(until, { label: "until" });

      if (chat) {
        const { entity, title } = await resolveChat(chat);
        const fromUser = from_user ? (await resolveChat(from_user)).entity : undefined;
        const messages = await collectMessages(entity, {
          since: sinceDate,
          until: untilDate,
          limit,
          search: query,
          fromUser,
        });
        if (!messages.length) return `No matches for "${query}" in "${title}".`;
        return `${messages.length} matches in "${title}":\n${await formatMessages(messages)}`;
      }

      const client = await getClient();
      const res = await client.invoke(
        new Api.messages.SearchGlobal({
          q: query,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: sinceDate ? unix(sinceDate) : 0,
          maxDate: untilDate ? unix(untilDate) : 0,
          offsetRate: 0,
          offsetPeer: new Api.InputPeerEmpty(),
          offsetId: 0,
          limit,
        })
      );
      if (res.className === "messages.MessagesNotModified") return "Telegram returned no changes.";

      const names = new Map<string, string>();
      for (const u of res.users) names.set(u.id.toString(), entityName(u as Entity));
      for (const c of res.chats) names.set(c.id.toString(), entityName(c as Entity));

      const messages = res.messages.filter((m): m is Api.Message => m.className === "Message");
      if (!messages.length) return `No matches for "${query}" across your chats.`;
      const lines = messages.map((m) => {
        const chatName = names.get(peerId(m.peerId) ?? "") ?? "?";
        const from = m.fromId ? (names.get(peerId(m.fromId) ?? "") ?? "") : "";
        const body = m.message || `(${mediaSummary(m) ?? "media"})`;
        return `[#${m.id} ${fmtDate(m.date)}] ${chatName}${from ? ` / ${from}` : ""}: ${body}`;
      });
      return `${messages.length} matches for "${query}":\n${lines.join("\n")}`;
    }
  );

  tool(
    server,
    "get_message",
    {
      title: "Get message details",
      description: "Fetch specific messages by id with full metadata: reactions, replies, forwards, media, URLs.",
      inputSchema: {
        chat: chatArg,
        message_ids: z.array(z.number().int()).min(1).max(50).describe("Message ids to fetch."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, message_ids }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const messages = await client.getMessages(entity, { ids: message_ids });
      const found = messages.filter(Boolean);
      if (!found.length) return `No messages with ids ${message_ids.join(", ")} in "${title}".`;
      const blocks: string[] = [];
      for (const m of found) blocks.push(await describeMessage(m));
      return blocks.join("\n---\n");
    }
  );

  tool(
    server,
    "get_replies",
    {
      title: "Get thread replies",
      description:
        "Fetch the reply thread / comments under a message (works for channel posts with a discussion group and for forum topics).",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int().describe("The root message id."),
        limit: z.number().int().min(1).max(500).default(100),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, message_id, limit }) => {
      const { entity, title } = await resolveChat(chat);
      const messages = await collectMessages(entity, { replyTo: message_id, limit });
      if (!messages.length) return `No replies to #${message_id} in "${title}".`;
      return `${messages.length} replies to #${message_id} in "${title}":\n${await formatMessages(messages)}`;
    }
  );

  tool(
    server,
    "get_unread",
    {
      title: "What did I miss",
      description:
        "Everything unread across your chats: which chats have unread messages and what the latest ones say. Does not mark anything as read.",
      inputSchema: {
        max_chats: z.number().int().min(1).max(50).default(10).describe("How many unread chats to expand."),
        per_chat: z.number().int().min(1).max(50).default(10).describe("Messages to show per chat."),
        include_muted: z.boolean().default(false),
        type: chatTypeArg,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ max_chats, per_chat, include_muted, type }) => {
      const dialogs = await getDialogs({ refresh: true });
      const unread = dialogs
        .filter((d) => d.unreadCount > 0)
        .filter((d) => include_muted || !d.dialog.notifySettings.muteUntil)
        .filter((d) => type === "all" || TYPE_GROUPS[type].includes(entityType(d.entity as Entity | undefined)));

      if (!unread.length) return "Nothing unread. 🎉";

      const total = unread.reduce((sum, d) => sum + d.unreadCount, 0);
      const overview = unread
        .map((d) => `  ${d.unreadCount.toString().padStart(4)} · ${dialogTitle(d)} (${d.id})`)
        .join("\n");

      const blocks: string[] = [];
      for (const d of unread.slice(0, max_chats)) {
        const messages = await collectMessages(d.entity as Entity, {
          limit: Math.min(d.unreadCount, per_chat),
        });
        blocks.push(
          `\n### ${dialogTitle(d)} (${d.id}) — ${d.unreadCount} unread\n${await formatMessages(messages)}`
        );
      }
      const omitted =
        unread.length > max_chats ? `\n\n(${unread.length - max_chats} more chats not expanded)` : "";
      return `${total} unread messages in ${unread.length} chats:\n${overview}\n${blocks.join("\n")}${omitted}`;
    }
  );

  tool(
    server,
    "chat_digest",
    {
      title: "Chat digest / stats",
      description:
        "Statistical summary of a chat over a period: who talked how much, activity per day and hour, links shared, media counts, and the most-reacted messages. Pair it with get_history when you need the actual text.",
      inputSchema: {
        chat: chatArg,
        since: z.string().default("7d").describe("Start of the window. Default: last 7 days."),
        until: untilArg,
        limit: z.number().int().min(1).max(3000).default(2000).describe("Max messages to scan."),
        top: z.number().int().min(1).max(50).default(10).describe("How many entries per top-list."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, since, until, limit, top }) => {
      const { entity, title, id } = await resolveChat(chat);
      const messages = await collectMessages(entity, {
        since: parseTime(since, { label: "since" }),
        until: parseTime(until, { label: "until" }),
        limit,
      });
      const first = messages[0];
      const last = messages.at(-1);
      if (!first || !last) return `No messages in "${title}" for that window.`;

      const bySender = new Map<string, SenderStats>();
      const byDay = new Map<string, number>();
      const byHour = new Array<number>(24).fill(0);
      const media = new Map<string, number>();
      const domains = new Map<string, number>();
      const urls: { url: string; id: number; from: string }[] = [];
      let replies = 0;
      let forwards = 0;

      for (const m of messages) {
        const name = await senderName(m);
        const stats = bySender.get(name) ?? { count: 0, chars: 0, reactions: 0 };
        stats.count += 1;
        stats.chars += m.message.length;
        stats.reactions += reactionTotal(m);
        bySender.set(name, stats);

        const day = dayKey(m.date);
        byDay.set(day, (byDay.get(day) ?? 0) + 1);
        byHour[hourOf(m.date)] = (byHour[hourOf(m.date)] ?? 0) + 1;

        const kind = mediaSummary(m)?.split(" ")[0];
        if (kind) media.set(kind, (media.get(kind) ?? 0) + 1);
        if (m.replyTo?.className === "MessageReplyHeader" && m.replyTo.replyToMsgId) replies += 1;
        if (m.fwdFrom) forwards += 1;

        for (const url of extractUrls(m)) {
          urls.push({ url, id: m.id, from: name });
          try {
            const host = new URL(url).hostname.replace(/^www\./, "");
            domains.set(host, (domains.get(host) ?? 0) + 1);
          } catch {
            /* not a parseable URL */
          }
        }
      }

      const total = messages.length;
      const days = [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
      const maxDay = Math.max(...days.map(([, c]) => c));
      const peakHour = byHour.indexOf(Math.max(...byHour));
      const senders = [...bySender.entries()].sort((a, b) => b[1].count - a[1].count);
      const topCount = senders[0]?.[1].count ?? 1;
      const reacted = messages
        .filter((m) => reactionTotal(m) > 0)
        .sort((a, b) => reactionTotal(b) - reactionTotal(a))
        .slice(0, Math.min(top, 5));

      const out = [
        `# Digest: "${title}" (${id})`,
        `Window: ${fmtDate(first.date)} → ${fmtDate(last.date)}`,
        `Messages: ${total} · participants: ${senders.length} · replies: ${replies} · forwards: ${forwards} · links: ${urls.length}`,
        "",
        "## Who talked",
        ...senders.slice(0, top).map(([name, s]) => {
          const share = pct(s.count, total).padStart(4);
          const received = s.reactions ? ` · ${s.reactions} reactions received` : "";
          return `  ${String(s.count).padStart(5)} (${share}) ${bar(s.count, topCount, 16).padEnd(16)} ${name}${received}`;
        }),
        "",
        "## Activity per day",
        ...days.map(([day, c]) => `  ${day} ${String(c).padStart(4)} ${bar(c, maxDay, 24)}`),
        `Peak hour: ${String(peakHour).padStart(2, "0")}:00 (${byHour[peakHour]} messages)`,
      ];

      if (media.size) {
        out.push(
          "",
          "## Media",
          [...media.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k, c]) => `  ${c} × ${k}`)
            .join("\n")
        );
      }
      if (domains.size) {
        out.push(
          "",
          "## Top link domains",
          [...domains.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, top)
            .map(([host, c]) => `  ${c} × ${host}`)
            .join("\n"),
          "Links:",
          urls
            .slice(0, top)
            .map((u) => `  #${u.id} ${u.from}: ${u.url}`)
            .join("\n")
        );
      }
      if (reacted.length) {
        out.push("", "## Most reacted");
        for (const m of reacted) {
          const body = (m.message || mediaSummary(m) || "").slice(0, 160);
          out.push(`  #${m.id} (${reactionTotal(m)}) ${await senderName(m)}: ${body}`);
        }
      }
      return out.join("\n");
    }
  );
}
