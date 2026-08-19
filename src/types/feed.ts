import type { ID } from "./common";
import type { Comment, Post } from "./post";

/**
 * Presentation-layer types for the Feed (Phase 06), same joined-view
 * convention as `NotificationWithActor` (types/dashboard.ts) — `Post` and
 * `Comment` only store `authorId`, but a card needs a name/avatar to render.
 */
export interface PostAuthor {
  id: ID;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  builderRank: string;
}

export interface PostWithAuthor extends Post {
  author: PostAuthor;
}

export interface CommentWithAuthor extends Comment {
  author: PostAuthor;
}

/** PRD.md §4.4 Feed. */
export type FeedFilter =
  | "trending"
  | "latest"
  | "following"
  | "recommended"
  | "popular_today"
  | "ai_recommended";
