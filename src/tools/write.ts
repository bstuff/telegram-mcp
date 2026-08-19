import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import bigInt from "big-integer";
import { Api, getClient, inputPeer, resolveChat } from "../client.ts";
import { fmtDate, messageLink, parseTime, peerId, unix } from "../format.ts";
import type { Entity } from "../types.ts";
import { chatArg, parseModeArg, parseModeValue, tool, z } from "./helpers.ts";

function sentLine(entity: Entity, messageId: number, verb = "Sent"): string {
  const link = messageLink(entity, messageId);
  return `${verb} message #${messageId}${link ? ` — ${link}` : ""}`;
}

function futureDate(value: string | undefined, label: string): Date | undefined {
  const date = parseTime(value, { label, direction: "future" });
  if (date && date.getTime() <= Date.now()) {
    throw new Error(`${label} must be in the future (got ${fmtDate(unix(date))}).`);
  }
  return date;
}

export function registerWriteTools(server: McpServer): void {
  tool(
    server,
    "send_message",
    {
      title: "Send a message",
      description:
        "Send a text message to a chat. Supports replies, comments on channel posts, silent delivery and scheduling.",
      inputSchema: {
        chat: chatArg,
        text: z.string().min(1).max(4096).describe("Message body."),
        reply_to: z.number().int().optional().describe("Id of the message to reply to."),
        comment_to: z
          .number()
          .int()
          .optional()
          .describe("Id of a channel post to comment on (uses the linked group)."),
        parse_mode: parseModeArg,
        silent: z.boolean().default(false).describe("Deliver without a notification sound."),
        link_preview: z.boolean().default(true),
        schedule_at: z
          .string()
          .optional()
          .describe("Send later: ISO timestamp, or a relative offset from now like '2h' / '30m'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chat, text, reply_to, comment_to, parse_mode, silent, link_preview, schedule_at }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const schedule = futureDate(schedule_at, "schedule_at");
      const message = await client.sendMessage(entity, {
        message: text,
        replyTo: reply_to,
        commentTo: comment_to,
        parseMode: parseModeValue(parse_mode),
        silent,
        linkPreview: link_preview,
        schedule: schedule ? unix(schedule) : undefined,
      });
      if (schedule) return `Scheduled message #${message.id} to "${title}" for ${fmtDate(unix(schedule))}.`;
      return `${sentLine(entity, message.id)} to "${title}".`;
    }
  );

  tool(
    server,
    "edit_message",
    {
      title: "Edit a message",
      description: "Replace the text of a message you sent.",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int(),
        text: z.string().min(1).max(4096),
        parse_mode: parseModeArg,
        link_preview: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chat, message_id, text, parse_mode, link_preview }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const message = await client.editMessage(entity, {
        message: message_id,
        text,
        parseMode: parseModeValue(parse_mode),
        linkPreview: link_preview,
      });
      return sentLine(entity, message.id, `Edited message in "${title}":`);
    }
  );

  tool(
    server,
    "delete_messages",
    {
      title: "Delete messages",
      description: "Delete messages. With revoke=true they are removed for everyone. This cannot be undone.",
      inputSchema: {
        chat: chatArg,
        message_ids: z.array(z.number().int()).min(1).max(100),
        revoke: z.boolean().default(true).describe("Delete for everyone, not just locally."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_ids, revoke }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      await client.deleteMessages(entity, message_ids, { revoke });
      return `Deleted ${message_ids.length} message(s) from "${title}"${revoke ? " for everyone" : " locally"}.`;
    }
  );

  tool(
    server,
    "forward_messages",
    {
      title: "Forward messages",
      description: "Forward messages from one chat to another.",
      inputSchema: {
        from_chat: chatArg,
        to_chat: chatArg,
        message_ids: z.array(z.number().int()).min(1).max(100),
        silent: z.boolean().default(false),
        drop_author: z.boolean().default(false).describe("Send as a copy, without the 'forwarded from' header."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ from_chat, to_chat, message_ids, silent, drop_author }) => {
      const client = await getClient();
      const from = await resolveChat(from_chat);
      const to = await resolveChat(to_chat);
      const result = await client.forwardMessages(to.entity, {
        messages: message_ids,
        fromPeer: from.entity,
        silent,
        dropAuthor: drop_author,
      });
      // Basic groups sometimes return messages without ids in the update batch.
      const ids = result.map((m) => m?.id).filter((id): id is number => typeof id === "number");
      const idNote = ids.length ? ` (new ids: ${ids.join(", ")})` : "";
      return `Forwarded ${result.length} message(s) from "${from.title}" to "${to.title}"${idNote}.`;
    }
  );

  tool(
    server,
    "react",
    {
      title: "React to a message",
      description: "Add or remove an emoji reaction on a message.",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int(),
        emoji: z
          .string()
          .optional()
          .describe("Emoji to set, e.g. 👍 🔥 ❤️. Omit (or pass an empty string) to remove your reaction."),
        big: z.boolean().default(false).describe("Play the big animated effect."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id, emoji, big }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      await client.invoke(
        new Api.messages.SendReaction({
          peer: entity,
          msgId: message_id,
          reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [],
          big,
          addToRecent: true,
        })
      );
      return emoji
        ? `Reacted ${emoji} to #${message_id} in "${title}".`
        : `Removed your reaction from #${message_id} in "${title}".`;
    }
  );

  tool(
    server,
    "pin_message",
    {
      title: "Pin a message",
      description: "Pin a message in a chat.",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int(),
        notify: z.boolean().default(false).describe("Notify members about the pin."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id, notify }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      await client.pinMessage(entity, message_id, { notify });
      return `Pinned #${message_id} in "${title}".`;
    }
  );

  tool(
    server,
    "unpin_message",
    {
      title: "Unpin messages",
      description: "Unpin one message, or all pinned messages when message_id is omitted.",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_id }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      if (message_id === undefined) {
        await client.unpinMessage(entity);
        return `Unpinned everything in "${title}".`;
      }
      await client.unpinMessage(entity, message_id);
      return `Unpinned #${message_id} in "${title}".`;
    }
  );

  tool(
    server,
    "mark_read",
    {
      title: "Mark chat as read",
      description: "Clear the unread badge for a chat (optionally only up to a given message id).",
      inputSchema: {
        chat: chatArg,
        max_id: z.number().int().optional().describe("Mark read up to this message id."),
        clear_mentions: z.boolean().default(true),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, max_id, clear_mentions }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      await client.markAsRead(entity, undefined, { maxId: max_id, clearMentions: clear_mentions });
      return `Marked "${title}" as read${max_id ? ` up to #${max_id}` : ""}.`;
    }
  );

  tool(
    server,
    "list_scheduled",
    {
      title: "List scheduled messages",
      description: "Show messages you have scheduled to be sent later in a chat.",
      inputSchema: { chat: chatArg },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const res = await client.invoke(
        new Api.messages.GetScheduledHistory({ peer: entity, hash: bigInt(0) })
      );
      if (res.className === "messages.MessagesNotModified") return `Nothing scheduled in "${title}".`;
      const messages = res.messages.filter((m): m is Api.Message => m.className === "Message");
      if (!messages.length) return `Nothing scheduled in "${title}".`;
      const lines = messages.map((m) => `#${m.id} → ${fmtDate(m.date)}: ${m.message || "(media)"}`);
      return `${messages.length} scheduled in "${title}":\n${lines.join("\n")}`;
    }
  );

  tool(
    server,
    "cancel_scheduled",
    {
      title: "Cancel scheduled messages",
      description: "Delete messages that were scheduled but not sent yet.",
      inputSchema: {
        chat: chatArg,
        message_ids: z.array(z.number().int()).min(1).max(100),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, message_ids }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      await client.invoke(new Api.messages.DeleteScheduledMessages({ peer: entity, id: message_ids }));
      return `Cancelled ${message_ids.length} scheduled message(s) in "${title}".`;
    }
  );

  tool(
    server,
    "set_mute",
    {
      title: "Mute or unmute a chat",
      description: "Mute a chat for a while (or forever), or unmute it.",
      inputSchema: {
        chat: chatArg,
        muted: z.boolean().describe("true to mute, false to unmute."),
        minutes: z.number().int().min(1).optional().describe("Mute duration. Omit for 'forever'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, muted, minutes }) => {
      const client = await getClient();
      const { title } = await resolveChat(chat);
      const peer = await inputPeer(chat);
      const muteUntil = muted ? (minutes ? Math.floor(Date.now() / 1000) + minutes * 60 : 2147483647) : 0;
      await client.invoke(
        new Api.account.UpdateNotifySettings({
          // teleproto types this field as EntityLike, but a ready InputNotifyPeer
          // is what the wire format wants and what worked against the servers.
          peer: new Api.InputNotifyPeer({ peer }) as unknown as Api.TypeEntityLike,
          settings: new Api.InputPeerNotifySettings({ muteUntil }),
        })
      );
      if (!muted) return `Unmuted "${title}".`;
      return minutes ? `Muted "${title}" for ${minutes} minutes.` : `Muted "${title}" indefinitely.`;
    }
  );

  tool(
    server,
    "get_draft",
    {
      title: "Read pending drafts",
      description: "Show unsent drafts across your chats — useful for picking up where you left off.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () => {
      const client = await getClient();
      const res = await client.invoke(new Api.messages.GetAllDrafts());
      if (!("updates" in res)) return "No drafts.";
      const drafts = res.updates.filter(
        (u): u is Api.UpdateDraftMessage => u.className === "UpdateDraftMessage"
      );
      const names = new Map<string, string>();
      if ("chats" in res) for (const c of res.chats) names.set(c.id.toString(), "title" in c ? c.title : "");
      if ("users" in res) {
        for (const u of res.users) {
          if (u.className === "User") {
            names.set(u.id.toString(), [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || "");
          }
        }
      }
      const lines = drafts
        .filter((u) => u.draft.className === "DraftMessage" && u.draft.message)
        .map((u) => {
          const key = peerId(u.peer) ?? "";
          const draft = u.draft as Api.DraftMessage;
          return `${names.get(key) || key}: ${draft.message}`;
        });
      return lines.length ? lines.join("\n") : "No drafts.";
    }
  );
}
