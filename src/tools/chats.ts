import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  Api,
  dialogTitle,
  entityName,
  entityType,
  entityUsername,
  getClient,
  getDialogs,
  getMe,
  markedId,
  resolveChat,
} from "../client.ts";
import { fmtDate, senderName } from "../format.ts";
import type { Entity } from "../types.ts";
import { TYPE_GROUPS, chatArg, chatTypeArg, tool, z } from "./helpers.ts";

export function registerChatTools(server: McpServer): void {
  tool(
    server,
    "whoami",
    {
      title: "Who am I",
      description: "Show the Telegram account this server is signed in as.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const me = await getMe();
      return [
        `name: ${entityName(me)}`,
        `id: ${me.id}`,
        `username: ${me.username ? "@" + me.username : "(none)"}`,
        `phone: ${me.phone ? "+" + me.phone : "(hidden)"}`,
        `premium: ${me.premium ? "yes" : "no"}`,
      ].join("\n");
    }
  );

  tool(
    server,
    "list_chats",
    {
      title: "List chats",
      description:
        "List your dialogs (chats, groups, channels), optionally filtered by name, type, or unread state. Use this to find the id of a chat.",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive substring of the chat title or @username."),
        type: chatTypeArg,
        unread_only: z.boolean().default(false),
        archived: z
          .boolean()
          .optional()
          .describe("true = archived folder only, false = main folder only, omit = both."),
        limit: z.number().int().min(1).max(500).default(50),
        refresh: z.boolean().default(false).describe("Force a refetch instead of using the cached dialog list."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, type, unread_only, archived, limit, refresh }) => {
      const dialogs = await getDialogs({ refresh });
      const needle = query?.toLowerCase();

      const rows = dialogs.filter((d) => {
        const kind = entityType(d.entity as Entity | undefined);
        if (type !== "all" && !TYPE_GROUPS[type].includes(kind)) return false;
        if (unread_only && !d.unreadCount) return false;
        if (archived !== undefined && Boolean(d.archived) !== archived) return false;
        if (!needle) return true;
        const hay = `${dialogTitle(d)} ${entityUsername(d.entity as Entity | undefined) ?? ""}`.toLowerCase();
        return hay.includes(needle);
      });

      if (!rows.length) return `No chats matched (searched ${dialogs.length} cached dialogs).`;

      const lines = rows.slice(0, limit).map((d) => {
        const entity = d.entity as Entity | undefined;
        const parts = [
          (d.id?.toString() ?? "?").padStart(14),
          entityType(entity).padEnd(10),
          dialogTitle(d),
        ];
        const username = entityUsername(entity);
        if (username) parts.push(`@${username}`);
        if (d.unreadCount) parts.push(`unread:${d.unreadCount}`);
        if (d.pinned) parts.push("pinned");
        if (d.archived) parts.push("archived");
        if (d.message?.date) parts.push(`last:${fmtDate(d.message.date)}`);
        return parts.join(" | ");
      });

      const shown = Math.min(rows.length, limit);
      return `${shown} of ${rows.length} matching chats (${dialogs.length} cached):\n${lines.join("\n")}`;
    }
  );

  tool(
    server,
    "get_chat",
    {
      title: "Chat info",
      description: "Detailed info about one chat: type, id, username, description, member count, pinned message.",
      inputSchema: { chat: chatArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat }) => {
      const client = await getClient();
      const { entity, id, title, type, username } = await resolveChat(chat);
      const lines = [`title: ${title}`, `id: ${id}`, `type: ${type}`];
      if (username) lines.push(`username: @${username}`);

      try {
        if (entity.className === "Channel") {
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
          const f = full.fullChat;
          if (f.className !== "ChannelFull") throw new Error("unexpected full chat type");
          if (f.about) lines.push(`about: ${f.about}`);
          if (f.participantsCount !== undefined) lines.push(`members: ${f.participantsCount}`);
          if (f.onlineCount) lines.push(`online: ${f.onlineCount}`);
          if (f.slowmodeSeconds) lines.push(`slowmode: ${f.slowmodeSeconds}s`);
          if (f.linkedChatId) lines.push(`linked_chat: ${f.linkedChatId}`);
          if (f.pinnedMsgId) lines.push(`pinned_message_id: ${f.pinnedMsgId}`);
        } else if (entity.className === "Chat") {
          const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
          const f = full.fullChat;
          if (f.className === "ChatFull") {
            if (f.about) lines.push(`about: ${f.about}`);
            if (f.participants.className === "ChatParticipants") {
              lines.push(`members: ${f.participants.participants.length}`);
            }
            if (f.pinnedMsgId) lines.push(`pinned_message_id: ${f.pinnedMsgId}`);
          }
        } else if (entity.className === "User") {
          const full = await client.invoke(new Api.users.GetFullUser({ id: entity }));
          const f = full.fullUser;
          if (f.about) lines.push(`bio: ${f.about}`);
          if (entity.phone) lines.push(`phone: +${entity.phone}`);
          if (entity.bot) lines.push("bot: yes");
          if (f.blocked) lines.push("blocked: yes");
          if (f.commonChatsCount) lines.push(`chats_in_common: ${f.commonChatsCount}`);
          if (f.pinnedMsgId) lines.push(`pinned_message_id: ${f.pinnedMsgId}`);
        }
      } catch (err) {
        lines.push(`(extended info unavailable: ${err instanceof Error ? err.message : String(err)})`);
      }

      const dialog = (await getDialogs()).find((d) => d.id?.toString() === id);
      if (dialog) {
        lines.push(`unread: ${dialog.unreadCount || 0}`);
        if (dialog.unreadMentionsCount) lines.push(`unread_mentions: ${dialog.unreadMentionsCount}`);
        if (dialog.message) {
          const last = dialog.message;
          lines.push(
            `last_message: [#${last.id} ${fmtDate(last.date)}] ${await senderName(last)}: ${last.message || "(media)"}`
          );
        }
      }
      return lines.join("\n");
    }
  );

  tool(
    server,
    "list_members",
    {
      title: "List chat members",
      description: "List participants of a group or channel (admins-only info where the account lacks rights).",
      inputSchema: {
        chat: chatArg,
        query: z.string().optional().describe("Filter by name or username."),
        limit: z.number().int().min(1).max(500).default(100),
        admins_only: z.boolean().default(false),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, query, limit, admins_only }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const members = await client.getParticipants(entity, {
        limit,
        search: query ?? "",
        ...(admins_only ? { filter: new Api.ChannelParticipantsAdmins() } : {}),
      });
      if (!members.length) return `No members found in "${title}".`;
      const lines = members.map((u) => {
        const bits = [u.id.toString().padStart(12), entityName(u)];
        if (u.username) bits.push(`@${u.username}`);
        if (u.bot) bits.push("bot");
        if (u.deleted) bits.push("deleted");
        return bits.join(" | ");
      });
      const total = members.total ? ` (total ${members.total})` : "";
      return `${members.length} members of "${title}"${total}:\n${lines.join("\n")}`;
    }
  );

  tool(
    server,
    "find_public_chat",
    {
      title: "Search Telegram globally",
      description:
        "Search Telegram for public users, groups and channels you are not necessarily in. Use list_chats first for your own dialogs.",
      inputSchema: {
        query: z.string().describe("Name or @username to look for."),
        limit: z.number().int().min(1).max(50).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      const client = await getClient();
      const res = await client.invoke(new Api.contacts.Search({ q: query, limit }));
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const e of [...res.users, ...res.chats] as Entity[]) {
        const id = markedId(e);
        if (seen.has(id)) continue;
        seen.add(id);
        const username = entityUsername(e);
        lines.push(
          [id.padStart(14), entityType(e).padEnd(10), entityName(e), username ? `@${username}` : ""]
            .filter(Boolean)
            .join(" | ")
        );
      }
      // Telegram applies `limit` per result list (contacts + global), so trim here too.
      return lines.length ? lines.slice(0, limit).join("\n") : `Nothing found for "${query}".`;
    }
  );
}
