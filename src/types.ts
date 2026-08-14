import type { Api } from "telegram";

/**
 * GramJS declares these in define.d.ts but exports nothing from it, so the
 * shapes we need are re-declared here.
 */
export type Entity =
  | Api.User
  | Api.UserEmpty
  | Api.Chat
  | Api.ChatEmpty
  | Api.ChatForbidden
  | Api.Channel
  | Api.ChannelForbidden;

export interface ResolvedChat {
  entity: Entity;
  /** Marked id: users positive, chats -id, channels -100<id>. */
  id: string;
  title: string;
  type: string;
  username: string | null;
}

export type ChatKind = "user" | "bot" | "group" | "supergroup" | "broadcast_group" | "channel" | "unknown";
