import type { Api as ApiNs, TelegramClient } from "telegram";
import { Api, entityName, getClient } from "./client.ts";
import { config } from "./config.ts";
import type { Entity } from "./types.ts";

export type Message = ApiNs.Message;

/* ------------------------------------------------------------------ *
 * Time
 * ------------------------------------------------------------------ */

const UNITS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

export interface ParseTimeOptions {
  label?: string;
  /** Bare relative offsets ("3h") point backwards for windows, forwards for scheduling. */
  direction?: "past" | "future";
}

/**
 * Parses "7d", "36h", "yesterday", "2026-07-17", "2026-07-17T10:00", or a unix
 * timestamp into a Date. An explicit sign ("+3h" / "-3h") always wins over
 * `direction`.
 */
export function parseTime(value: string | undefined, options: ParseTimeOptions = {}): Date | undefined {
  const { label = "time", direction = "past" } = options;
  if (value === undefined || value === null || value === "") return undefined;

  const raw = String(value).trim();
  const lower = raw.toLowerCase();

  if (lower === "now") return new Date();
  if (lower === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
  if (lower === "yesterday") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - 1);
    return d;
  }

  const rel = /^(?:in\s+)?([+-]?)(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/.exec(lower);
  if (rel) {
    const sign = rel[1] === "+" ? 1 : rel[1] === "-" ? -1 : direction === "future" ? 1 : -1;
    return new Date(Date.now() + sign * Number(rel[2]) * (UNITS[rel[3] as string] as number) * 1000);
  }

  if (/^\d{9,10}$/.test(raw)) return new Date(Number(raw) * 1000);
  if (/^\d{12,13}$/.test(raw)) return new Date(Number(raw));

  // Bare dates are interpreted in local time, not UTC.
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00`) : new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Could not parse ${label} "${raw}". Use "7d", "yesterday", "2026-07-17", or an ISO timestamp.`
    );
  }
  return parsed;
}

export const unix = (date: Date): number => Math.floor(date.getTime() / 1000);

export function fmtDate(tsSeconds: number | undefined, { withSeconds = false } = {}): string {
  if (!tsSeconds) return "?";
  // sv-SE gives an ISO-like "2026-08-09 14:22:05" in the target timezone.
  return new Date(tsSeconds * 1000)
    .toLocaleString("sv-SE", {
      timeZone: config.timezone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      ...(withSeconds ? { second: "2-digit" } : {}),
    })
    .replace(",", "");
}

export const dayKey = (tsSeconds: number): string => fmtDate(tsSeconds).slice(0, 10);
export const hourOf = (tsSeconds: number): number => Number(fmtDate(tsSeconds).slice(11, 13));

/* ------------------------------------------------------------------ *
 * Senders
 * ------------------------------------------------------------------ */

const senderCache = new Map<string, string>();

export async function senderName(message: Message | undefined): Promise<string> {
  if (!message) return "Unknown";
  const id = message.senderId?.toString();
  if (!id) return message.postAuthor || (message.out ? "Me" : "Channel");
  const cached = senderCache.get(id);
  if (cached) return cached;
  let name = id;
  try {
    const sender = await message.getSender();
    if (sender) name = entityName(sender as Entity);
  } catch {
    /* deleted account, or entity not cached — fall back to the id */
  }
  senderCache.set(id, name);
  return name;
}

/* ------------------------------------------------------------------ *
 * Message rendering
 * ------------------------------------------------------------------ */

export function mediaSummary(message: Message | undefined): string | null {
  const media = message?.media;
  if (!media) return null;
  switch (media.className) {
    case "MessageMediaPhoto":
      return "photo";
    case "MessageMediaDocument": {
      const doc = media.document;
      const attrs = doc?.className === "Document" ? doc.attributes : [];
      const file = attrs.find((a) => a.className === "DocumentAttributeFilename")?.fileName;
      const audio = attrs.find((a) => a.className === "DocumentAttributeAudio");
      const video = attrs.find((a) => a.className === "DocumentAttributeVideo");
      if (attrs.some((a) => a.className === "DocumentAttributeSticker")) return "sticker";
      if (audio?.voice) return `voice ${audio.duration}s`;
      if (video) return video.roundMessage ? `video note ${video.duration}s` : `video ${video.duration}s`;
      if (audio) return `audio ${audio.duration}s`;
      const mime = doc?.className === "Document" ? doc.mimeType : "";
      const bytes = doc?.className === "Document" ? Number(doc.size) : 0;
      const size = bytes ? ` ${(bytes / 1024).toFixed(0)}KB` : "";
      return `file ${file || mime || ""}${size}`.trim();
    }
    case "MessageMediaPoll":
      return `poll "${pollQuestion(media.poll)}"`;
    case "MessageMediaDice":
      return `dice ${media.emoticon} = ${media.value}`;
    case "MessageMediaWebPage":
      return media.webpage.className === "WebPage" ? `link ${media.webpage.url}` : "link";
    case "MessageMediaGeo":
    case "MessageMediaGeoLive":
      return "location";
    case "MessageMediaContact":
      return `contact ${media.firstName} ${media.phoneNumber}`.trim();
    case "MessageMediaStory":
      return "story";
    case "MessageMediaGiveaway":
      return "giveaway";
    default:
      return media.className.replace(/^MessageMedia/, "").toLowerCase();
  }
}

export function pollQuestion(poll: Api.Poll | undefined): string {
  const q = poll?.question as unknown;
  if (typeof q === "string") return q;
  return (q as Api.TextWithEntities | undefined)?.text ?? "";
}

export function pollAnswerText(answer: Api.PollAnswer | undefined): string {
  const t = answer?.text as unknown;
  if (typeof t === "string") return t;
  return (t as Api.TextWithEntities | undefined)?.text ?? "";
}

export function reactionsSummary(message: Message | undefined): string | null {
  const results = message?.reactions?.results;
  if (!results?.length) return null;
  return results
    .map((r) => {
      const emoji =
        r.reaction.className === "ReactionEmoji"
          ? r.reaction.emoticon
          : r.reaction.className === "ReactionCustomEmoji"
            ? `custom:${r.reaction.documentId}`
            : "?";
      return `${emoji}${r.count}${r.chosenOrder !== undefined ? "*" : ""}`;
    })
    .join(" ");
}

export function reactionTotal(message: Message | undefined): number {
  return (message?.reactions?.results ?? []).reduce((sum, r) => sum + (r.count || 0), 0);
}

export function serviceAction(message: Message | undefined): string | null {
  const action = message?.action as (Api.TypeMessageAction & { title?: string }) | undefined;
  if (!action) return null;
  const pretty = action.className.replace(/^MessageAction/, "").replace(/([a-z])([A-Z])/g, "$1 $2");
  return `[${pretty.toLowerCase()}${action.title ? `: ${action.title}` : ""}]`;
}

export interface FormatOptions {
  showIds?: boolean;
}

/** One-line rendering used by history / search / digest output. */
export async function formatMessage(message: Message, { showIds = true }: FormatOptions = {}): Promise<string> {
  const name = await senderName(message);
  const head: string[] = [];
  if (showIds) head.push(`#${message.id}`);
  head.push(fmtDate(message.date));

  const meta: string[] = [];
  const replyTo = message.replyTo?.className === "MessageReplyHeader" ? message.replyTo.replyToMsgId : undefined;
  if (replyTo) meta.push(`↩#${replyTo}`);
  if (message.fwdFrom) meta.push("↷fwd");
  if (message.editDate) meta.push("edited");
  const media = mediaSummary(message);
  if (media) meta.push(`[${media}]`);
  const reactions = reactionsSummary(message);
  if (reactions) meta.push(reactions);

  const text = message.message || serviceAction(message) || "";
  const suffix = meta.length ? `  ${meta.join(" ")}` : "";
  return `[${head.join(" ")}] ${name}: ${text}${suffix}`;
}

export async function formatMessages(messages: Message[], opts?: FormatOptions): Promise<string> {
  const lines: string[] = [];
  for (const m of messages) lines.push(await formatMessage(m, opts));
  return lines.join("\n");
}

/** Verbose rendering for get_message. */
export async function describeMessage(message: Message): Promise<string> {
  const lines = [
    `id: ${message.id}`,
    `date: ${fmtDate(message.date, { withSeconds: true })}`,
    `from: ${await senderName(message)}${message.senderId ? ` (${message.senderId})` : ""}`,
  ];
  if (message.editDate) lines.push(`edited: ${fmtDate(message.editDate, { withSeconds: true })}`);
  if (message.replyTo?.className === "MessageReplyHeader" && message.replyTo.replyToMsgId) {
    lines.push(`reply_to: ${message.replyTo.replyToMsgId}`);
  }
  if (message.fwdFrom) {
    const from = message.fwdFrom.fromName ?? peerId(message.fwdFrom.fromId);
    lines.push(`forwarded_from: ${from ?? "unknown"} (${fmtDate(message.fwdFrom.date)})`);
  }
  if (message.pinned) lines.push("pinned: true");
  if (message.groupedId) lines.push(`album: ${message.groupedId}`);
  if (message.views) lines.push(`views: ${message.views}`);
  if (message.replies?.replies) lines.push(`replies: ${message.replies.replies}`);
  const media = mediaSummary(message);
  if (media) lines.push(`media: ${media}`);
  const reactions = reactionsSummary(message);
  if (reactions) lines.push(`reactions: ${reactions}`);
  const urls = extractUrls(message);
  if (urls.length) lines.push(`urls: ${urls.join(", ")}`);
  lines.push("text:", message.message || serviceAction(message) || "(empty)");
  return lines.join("\n");
}

export function peerId(peer: Api.TypePeer | undefined): string | undefined {
  if (!peer) return undefined;
  if (peer.className === "PeerUser") return peer.userId.toString();
  if (peer.className === "PeerChat") return peer.chatId.toString();
  if (peer.className === "PeerChannel") return peer.channelId.toString();
  return undefined;
}

/** Public t.me link when one exists, otherwise the internal /c/ form. */
export function messageLink(entity: Entity | undefined, messageId: number | undefined): string | null {
  if (!entity || !messageId) return null;
  if ((entity.className === "User" || entity.className === "Channel") && entity.username) {
    return `https://t.me/${entity.username}/${messageId}`;
  }
  if (entity.className === "Channel") return `https://t.me/c/${entity.id}/${messageId}`;
  return null;
}

export function extractUrls(message: Message): string[] {
  const urls = new Set<string>();
  for (const e of message.entities ?? []) {
    if (e.className === "MessageEntityUrl") {
      urls.add(message.message.slice(e.offset, e.offset + e.length));
    } else if (e.className === "MessageEntityTextUrl" && e.url) {
      urls.add(e.url);
    }
  }
  if (message.media?.className === "MessageMediaWebPage" && message.media.webpage.className === "WebPage") {
    urls.add(message.media.webpage.url);
  }
  return [...urls];
}

/* ------------------------------------------------------------------ *
 * Fetching
 * ------------------------------------------------------------------ */

export const MESSAGE_FILTERS = {
  photos: () => new Api.InputMessagesFilterPhotos(),
  videos: () => new Api.InputMessagesFilterVideo(),
  media: () => new Api.InputMessagesFilterPhotoVideo(),
  documents: () => new Api.InputMessagesFilterDocument(),
  links: () => new Api.InputMessagesFilterUrl(),
  voice: () => new Api.InputMessagesFilterVoice(),
  audio: () => new Api.InputMessagesFilterMusic(),
  gifs: () => new Api.InputMessagesFilterGif(),
  pinned: () => new Api.InputMessagesFilterPinned(),
  mentions: () => new Api.InputMessagesFilterMyMentions(),
} satisfies Record<string, () => Api.TypeMessagesFilter>;

export type MessageFilterName = keyof typeof MESSAGE_FILTERS;

export interface CollectOptions {
  since?: Date | undefined;
  until?: Date | undefined;
  limit?: number;
  fromUser?: Entity | undefined;
  search?: string | undefined;
  filter?: MessageFilterName | undefined;
  replyTo?: number | undefined;
  skipEmpty?: boolean;
}

/**
 * Walks history newest-first and returns messages oldest-first.
 * Stops at `since`, `limit`, or the global safety ceiling.
 */
export async function collectMessages(entity: Entity, options: CollectOptions = {}): Promise<Message[]> {
  const { since, until, limit = 200, fromUser, search, filter, replyTo, skipEmpty = true } = options;
  const client: TelegramClient = await getClient();
  const cap = Math.min(limit || config.maxMessages, config.maxMessages);
  const sinceTs = since ? unix(since) : 0;

  const params: Record<string, unknown> = {
    offsetDate: until ? unix(until) : 0,
    reverse: false,
  };
  if (search) params.search = search;
  if (fromUser) params.fromUser = fromUser;
  if (filter) params.filter = MESSAGE_FILTERS[filter]();
  if (replyTo) params.replyTo = replyTo;
  // Without a `since` bound, let GramJS stop after `cap` messages itself.
  if (!sinceTs) params.limit = cap;

  const out: Message[] = [];
  for await (const message of client.iterMessages(entity, params)) {
    if (sinceTs && message.date < sinceTs) break;
    if (skipEmpty && !message.message && !message.media && !message.action) continue;
    out.push(message);
    if (out.length >= cap) break;
  }
  out.reverse();
  return out;
}
