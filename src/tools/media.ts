import fs from "node:fs";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramClient } from "teleproto";
import { utils } from "teleproto";
import { Api, getClient, resolveChat } from "../client.ts";
import { config } from "../config.ts";
import type { Message } from "../format.ts";
import { collectMessages, fmtDate, mediaSummary, messageLink, parseTime, senderName, unix } from "../format.ts";
import { chatArg, parseModeArg, parseModeValue, tool, z } from "./helpers.ts";

const safeName = (name: string): string => name.replace(/[/\\:*?"<>|\x00-\x1f]/g, "_").slice(0, 120);

function guessFilename(message: Message): string {
  const media = message.media;
  const doc = media?.className === "MessageMediaDocument" ? media.document : undefined;
  const attrs = doc?.className === "Document" ? doc.attributes : [];
  const named = attrs.find((a) => a.className === "DocumentAttributeFilename")?.fileName;
  if (named) return safeName(named);

  let ext = "";
  try {
    ext = (utils.getExtension(media) || "").replace(/^\.+/, "");
  } catch {
    /* unknown media type */
  }
  if (!ext) ext = media?.className === "MessageMediaPhoto" ? "jpg" : "bin";
  return `${message.id}_${message.date}.${ext}`;
}

/**
 * A forwarded story carries only a reference (owner + story id), not the file,
 * so the story itself has to be fetched before anything can be downloaded.
 */
async function resolveStory(
  client: TelegramClient,
  media: Api.MessageMediaStory
): Promise<{ media: Api.TypeMessageMedia; label: string; caption?: string }> {
  const owner = await client.getEntity(media.peer);
  const handle = (owner as { username?: string }).username ?? owner.id.toString();

  const res = await client.invoke(new Api.stories.GetStoriesByID({ peer: owner, id: [media.id] }));
  const story = res.stories[0];
  if (!story || story.className === "StoryItemDeleted") {
    throw new Error(
      `Story ${media.id} by @${handle} is gone — stories expire after 24 hours unless the author pinned it.`
    );
  }
  if (story.className === "StoryItemSkipped") {
    throw new Error(`Story ${media.id} by @${handle} is not available to this account.`);
  }
  if (story.noforwards) {
    throw new Error(
      `Story ${media.id} by @${handle} is marked as protected content; the author disallowed saving it.`
    );
  }
  return { media: story.media, label: `story_${handle}_${media.id}`, caption: story.caption };
}

export function registerMediaTools(server: McpServer): void {
  tool(
    server,
    "send_file",
    {
      title: "Send a file",
      description:
        "Send a local file or a direct URL to a chat — photo, video, document, or voice note. Telegram downloads URLs itself.",
      inputSchema: {
        chat: chatArg,
        file: z.string().describe("Absolute local path, or a direct https URL to the file."),
        caption: z.string().max(1024).optional(),
        parse_mode: parseModeArg,
        as_document: z.boolean().default(false).describe("Send without compression, even for images."),
        voice_note: z.boolean().default(false).describe("Send an audio file as a voice message."),
        reply_to: z.number().int().optional(),
        silent: z.boolean().default(false),
        schedule_at: z
          .string()
          .optional()
          .describe("Send later: ISO timestamp, or a relative offset from now like '2h' / '30m'."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async ({ chat, file, caption, parse_mode, as_document, voice_note, reply_to, silent, schedule_at }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);

      let target = file;
      if (!/^https?:\/\//i.test(file)) {
        target = path.resolve(file);
        if (!fs.existsSync(target)) throw new Error(`File not found: ${target}`);
      }

      const schedule = parseTime(schedule_at, { label: "schedule_at", direction: "future" });
      if (schedule && schedule.getTime() <= Date.now()) {
        throw new Error(`schedule_at must be in the future (got ${fmtDate(unix(schedule))}).`);
      }

      const message = await client.sendFile(entity, {
        file: target,
        caption,
        parseMode: parseModeValue(parse_mode),
        forceDocument: as_document,
        voiceNote: voice_note,
        replyTo: reply_to,
        silent,
        scheduleDate: schedule ? unix(schedule) : undefined,
      });

      if (schedule) return `Scheduled file for ${fmtDate(unix(schedule))} in "${title}" (#${message.id}).`;
      const link = messageLink(entity, message.id);
      return `Sent ${path.basename(target)} to "${title}" as #${message.id}${link ? ` — ${link}` : ""}.`;
    }
  );

  tool(
    server,
    "download_media",
    {
      title: "Download media",
      description:
        "Download the media attached to a message and return the local path. Forwarded stories are resolved to the underlying photo or video first.",
      inputSchema: {
        chat: chatArg,
        message_id: z.number().int(),
        dir: z.string().optional().describe(`Target directory. Defaults to ${config.downloadDir}`),
        filename: z.string().optional().describe("Override the file name."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, message_id, dir, filename }) => {
      const client = await getClient();
      const { entity, title } = await resolveChat(chat);
      const [message] = await client.getMessages(entity, { ids: [message_id] });
      if (!message) throw new Error(`Message #${message_id} not found in "${title}".`);
      if (!message.media) throw new Error(`Message #${message_id} has no media.`);
      if (message.media.className === "MessageMediaWebPage") {
        throw new Error(`Message #${message_id} only contains a link preview, nothing to download.`);
      }

      const story =
        message.media.className === "MessageMediaStory"
          ? await resolveStory(client, message.media)
          : undefined;
      const source = story?.media ?? message.media;

      let name: string;
      if (filename) {
        name = safeName(filename);
      } else if (story) {
        name = `${story.label}.${source.className === "MessageMediaPhoto" ? "jpg" : "mp4"}`;
      } else {
        name = guessFilename(message);
      }

      const targetDir = path.resolve(dir || config.downloadDir);
      fs.mkdirSync(targetDir, { recursive: true });
      const outFile = path.join(targetDir, name);
      await client.downloadMedia(source, { outputFile: outFile });
      const size = fs.existsSync(outFile) ? fs.statSync(outFile).size : 0;

      const what = story ? `story (${mediaSummary({ media: source } as Message)})` : mediaSummary(message);
      const caption = story?.caption ? `\ncaption: ${story.caption}` : "";
      return `Downloaded ${what} from #${message_id} → ${outFile} (${(size / 1024).toFixed(0)} KB)${caption}`;
    }
  );

  tool(
    server,
    "list_media",
    {
      title: "List media in a chat",
      description:
        "List recent media messages (photos, videos, documents, voice) with their ids, ready for download_media.",
      inputSchema: {
        chat: chatArg,
        kind: z.enum(["media", "photos", "videos", "documents", "voice", "audio", "gifs"]).default("media"),
        limit: z.number().int().min(1).max(200).default(30),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ chat, kind, limit }) => {
      const { entity, title } = await resolveChat(chat);
      const messages = await collectMessages(entity, { limit, filter: kind });
      if (!messages.length) return `No ${kind} found in "${title}".`;
      const lines: string[] = [];
      for (const m of messages) {
        const caption = m.message ? ` — ${m.message.slice(0, 80)}` : "";
        lines.push(`#${m.id} ${fmtDate(m.date)} ${await senderName(m)}: ${mediaSummary(m)}${caption}`);
      }
      return `${messages.length} ${kind} in "${title}":\n${lines.join("\n")}`;
    }
  );
}
