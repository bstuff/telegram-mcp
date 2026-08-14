import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import type { Dialog } from "telegram/tl/custom/dialog.js";
import { config, readSession } from "./config.ts";
import type { ChatKind, Entity, ResolvedChat } from "./types.ts";

let clientPromise: Promise<TelegramClient> | null = null;
let mePromise: Promise<Api.User> | null = null;

/** Lazily connects on first tool call so the server starts instantly. */
export async function getClient(): Promise<TelegramClient> {
  if (clientPromise) return clientPromise;

  clientPromise = (async () => {
    const session = readSession();
    if (!config.apiId || !config.apiHash) {
      throw new Error(
        "TELEGRAM_API_ID / TELEGRAM_API_HASH are not set. Put them in .env or run `npm run login`."
      );
    }
    if (!session) {
      throw new Error(
        `No Telegram session found (checked $TELEGRAM_SESSION and ${config.sessionFile}). Run \`npm run login\`.`
      );
    }
    const client = new TelegramClient(new StringSession(session), config.apiId, config.apiHash, {
      connectionRetries: 5,
      autoReconnect: true,
      requestRetries: 3,
    });
    // GramJS chatters on stdout, which would corrupt the stdio JSON-RPC stream.
    try {
      client.setLogLevel?.("none" as never);
    } catch {
      /* older GramJS builds have no setLogLevel */
    }
    await client.connect();
    if (!(await client.isUserAuthorized())) {
      throw new Error("Telegram session is invalid or expired. Run `npm run login` to re-auth.");
    }
    return client;
  })();

  try {
    return await clientPromise;
  } catch (err) {
    clientPromise = null; // let the next call retry
    throw err;
  }
}

export async function getMe(): Promise<Api.User> {
  if (!mePromise) {
    mePromise = (async () => (await getClient()).getMe())().catch((err: unknown) => {
      mePromise = null;
      throw err;
    });
  }
  return mePromise;
}

export async function disconnect(): Promise<void> {
  if (!clientPromise) return;
  const client = await clientPromise.catch(() => null);
  clientPromise = null;
  if (client) await client.disconnect().catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Entity helpers
 * ------------------------------------------------------------------ */

export function entityType(entity: Entity | undefined): ChatKind {
  if (!entity) return "unknown";
  switch (entity.className) {
    case "User":
      return entity.bot ? "bot" : "user";
    case "Chat":
    case "ChatForbidden":
      return "group";
    case "Channel":
      return entity.megagroup ? "supergroup" : entity.gigagroup ? "broadcast_group" : "channel";
    default:
      return "unknown";
  }
}

/** Telegram's "marked" id: users positive, chats -id, channels -100<id>. */
export function markedId(entity: Entity | undefined): string {
  if (!entity) return "";
  const raw = entity.id.toString();
  switch (entity.className) {
    case "Chat":
    case "ChatEmpty":
    case "ChatForbidden":
      return `-${raw}`;
    case "Channel":
    case "ChannelForbidden":
      return `-100${raw}`;
    default:
      return raw;
  }
}

export function entityName(entity: Entity | undefined): string {
  if (!entity) return "Unknown";
  if (entity.className === "User") {
    const name = [entity.firstName, entity.lastName].filter(Boolean).join(" ");
    return name || entity.username || (entity.deleted ? "Deleted account" : entity.id.toString());
  }
  if (entity.className === "Chat" || entity.className === "ChatForbidden") return entity.title;
  if (entity.className === "Channel" || entity.className === "ChannelForbidden") {
    return entity.title || entity.id.toString();
  }
  return entity.id.toString();
}

export function entityUsername(entity: Entity | undefined): string | null {
  if (!entity) return null;
  if (entity.className === "User" || entity.className === "Channel") return entity.username ?? null;
  return null;
}

/* ------------------------------------------------------------------ *
 * Dialog cache + chat resolution
 * ------------------------------------------------------------------ */

let dialogCache: { at: number; dialogs: Dialog[] } = { at: 0, dialogs: [] };
const resolveCache = new Map<string, ResolvedChat>();

export async function getDialogs({ refresh = false } = {}): Promise<Dialog[]> {
  const fresh = Date.now() - dialogCache.at < config.dialogTtl * 1000;
  if (!refresh && fresh && dialogCache.dialogs.length) return dialogCache.dialogs;
  const client = await getClient();
  const dialogs = await client.getDialogs({ limit: config.dialogLimit });
  dialogCache = { at: Date.now(), dialogs: [...dialogs] };
  resolveCache.clear();
  return dialogCache.dialogs;
}

export function dialogTitle(dialog: Dialog): string {
  return dialog.title || dialog.name || entityName(dialog.entity as Entity | undefined);
}

const SELF_ALIASES = new Set(["me", "self", "saved", "saved messages", "избранное"]);

function usernameFrom(ref: string): string | null {
  const m = /^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]{4,})/.exec(ref);
  if (m) return m[1] as string;
  if (ref.startsWith("@")) return ref.slice(1);
  if (/^[A-Za-z0-9_]{4,32}$/.test(ref)) return ref;
  return null;
}

/**
 * Accepts an id (`-1001234567890`), a @username, a t.me link, "me",
 * or a fragment of a chat title ("Team standup").
 */
export async function resolveChat(ref: string): Promise<ResolvedChat> {
  if (ref === undefined || ref === null || String(ref).trim() === "") {
    throw new Error("`chat` is required (id, @username, t.me link, 'me', or part of the title)");
  }
  const key = String(ref).trim();
  const cached = resolveCache.get(key);
  if (cached) return cached;

  const client = await getClient();
  const entity = (await resolveUncached(client, key)) as Entity;
  const info: ResolvedChat = {
    entity,
    id: markedId(entity),
    title: entityName(entity),
    type: entityType(entity),
    username: entityUsername(entity),
  };
  resolveCache.set(key, info);
  return info;
}

async function resolveUncached(client: TelegramClient, key: string): Promise<Entity> {
  if (SELF_ALIASES.has(key.toLowerCase())) return (await client.getEntity("me")) as Entity;

  // Numeric id — look it up in the dialog cache first so GramJS has the access hash.
  if (/^-?\d+$/.test(key)) {
    const dialogs = await getDialogs();
    const bare = key.replace(/^-100|^-/, "");
    const hit = dialogs.find((d) => d.id?.toString() === key || d.entity?.id.toString() === bare);
    if (hit?.entity) return hit.entity as Entity;
    try {
      return (await client.getEntity(BigInt(key) as never)) as Entity;
    } catch (err) {
      throw new Error(
        `Chat ${key} not found among your ${dialogs.length} cached dialogs and could not be resolved directly (${
          err instanceof Error ? err.message : String(err)
        }). Try list_chats to find it.`
      );
    }
  }

  const username = usernameFrom(key);
  if (username) {
    try {
      return (await client.getEntity(username)) as Entity;
    } catch {
      /* fall through to a title search */
    }
  }

  const needle = key.toLowerCase();
  const dialogs = await getDialogs();
  const scored = dialogs
    .map((d) => ({ dialog: d, title: dialogTitle(d).toLowerCase() }))
    .filter(({ title }) => title.includes(needle));

  const only = scored[0];
  if (scored.length === 1 && only?.dialog.entity) return only.dialog.entity as Entity;
  if (scored.length > 1) {
    const exact = scored.find(({ title }) => title === needle);
    if (exact?.dialog.entity) return exact.dialog.entity as Entity;
    const list = scored
      .slice(0, 10)
      .map(({ dialog }) => `  • ${dialogTitle(dialog)} (id ${dialog.id})`)
      .join("\n");
    throw new Error(`"${key}" matches ${scored.length} chats — be more specific:\n${list}`);
  }
  throw new Error(
    `No chat matching "${key}". Use list_chats to see what's available (only the ${config.dialogLimit} most recent dialogs are cached).`
  );
}

/** InputPeer for raw API calls that need one. */
export async function inputPeer(chatRef: string): Promise<Api.TypeInputPeer> {
  const client = await getClient();
  const { entity } = await resolveChat(chatRef);
  return client.getInputEntity(entity);
}

export { Api };
