import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api, entityName, getClient, resolveChat } from "../client.ts";
import { messageLink } from "../format.ts";
import { chatArg, tool, z } from "./helpers.ts";

const DICE_KINDS = ["dice", "darts", "basketball", "football", "bowling", "slots"] as const;
type DiceKind = (typeof DICE_KINDS)[number];

const DICE: Record<DiceKind, string> = {
  dice: "🎲",
  darts: "🎯",
  basketball: "🏀",
  football: "⚽",
  bowling: "🎳",
  slots: "🎰",
};

// Telegram returns 1..6 (1..64 for slots); these read nicer in a summary.
const DICE_MEANING: Partial<Record<DiceKind, Record<number, string>>> = {
  darts: { 1: "way off", 2: "outer ring", 3: "middle ring", 4: "inner ring", 5: "near bullseye", 6: "bullseye!" },
  basketball: { 1: "airball", 2: "off the rim", 3: "rattles out", 4: "in!", 5: "swish!" },
  football: { 1: "miss", 2: "post", 3: "goal", 4: "goal", 5: "goal" },
  bowling: { 1: "gutter", 2: "1 pin", 3: "3 pins", 4: "4 pins", 5: "5 pins", 6: "STRIKE!" },
};

export function registerFunTools(server: McpServer): void {
  tool(
    server,
    "send_dice",
    {
      title: "Roll a dice / play an emoji game",
      description:
        "Send an animated Telegram dice game (dice, darts, basketball, football, bowling, slot machine) and report the result. The value is decided by Telegram's server, so it works as a fair random draw.",
      inputSchema: {
        chat: chatArg,
        kind: z.enum(DICE_KINDS).default("dice"),
        reply_to: z.number().int().optional(),
        silent: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chat, kind, reply_to, silent }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const message = await client.sendFile(entity, {
        file: new Api.InputMediaDice({ emoticon: DICE[kind] }),
        replyTo: reply_to,
        silent,
      });
      const value = message.media?.className === "MessageMediaDice" ? message.media.value : undefined;
      const meaning = value !== undefined ? DICE_MEANING[kind]?.[value] : undefined;
      const link = messageLink(entity, message.id);
      return `${DICE[kind]} rolled in "${title}": ${value ?? "?"}${meaning ? ` — ${meaning}` : ""} (#${
        message.id
      }${link ? `, ${link}` : ""})`;
    }
  );

  tool(
    server,
    "random_member",
    {
      title: "Pick a random member",
      description:
        "Pick one or more random members of a group — for picking a duty person, a reviewer, or a raffle winner. Does not post anything.",
      inputSchema: {
        chat: chatArg,
        count: z.number().int().min(1).max(20).default(1),
        exclude_bots: z.boolean().default(true),
        active_only: z
          .boolean()
          .default(false)
          .describe("Only pick among people who wrote in the last 200 messages."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, count, exclude_bots, active_only }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);

      let pool = [...(await client.getParticipants(entity, { limit: 500 }))].filter(
        (u) => !u.deleted && (!exclude_bots || !u.bot)
      );

      if (active_only) {
        const active = new Set<string>();
        for await (const m of client.iterMessages(entity, { limit: 200 })) {
          if (m.senderId) active.add(m.senderId.toString());
        }
        const filtered = pool.filter((u) => active.has(u.id.toString()));
        if (filtered.length) pool = filtered;
      }

      if (!pool.length) throw new Error(`No eligible members found in "${title}".`);

      const bag = [...pool];
      const picked: typeof pool = [];
      for (let i = 0; i < Math.min(count, bag.length); i++) {
        picked.push(...bag.splice(Math.floor(Math.random() * bag.length), 1));
      }
      const lines = picked.map(
        (u) => `  🎉 ${entityName(u)}${u.username ? ` (@${u.username})` : ""} — id ${u.id}`
      );
      return `Picked from ${pool.length} members of "${title}":\n${lines.join("\n")}`;
    }
  );

  tool(
    server,
    "set_typing",
    {
      title: "Show a typing indicator",
      description: "Show 'typing…' (or recording/uploading) in a chat for a few seconds. Purely cosmetic.",
      inputSchema: {
        chat: chatArg,
        action: z
          .enum(["typing", "recording_voice", "uploading_file", "choosing_sticker", "cancel"])
          .default("typing"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ chat, action }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const actions: Record<typeof action, () => Api.TypeSendMessageAction> = {
        typing: () => new Api.SendMessageTypingAction(),
        recording_voice: () => new Api.SendMessageRecordAudioAction(),
        uploading_file: () => new Api.SendMessageUploadDocumentAction({ progress: 0 }),
        choosing_sticker: () => new Api.SendMessageChooseStickerAction(),
        cancel: () => new Api.SendMessageCancelAction(),
      };
      await client.invoke(new Api.messages.SetTyping({ peer: entity, action: actions[action]() }));
      return `Sent "${action}" status to "${title}".`;
    }
  );
}
