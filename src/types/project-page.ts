import type { ID, ISODateString } from "./common";
import type { PostAuthor } from "./feed";
import type { ProjectMember, ProjectUpdate } from "./project";

/**
 * Presentation-layer types for the Project Page (Phase 07), same joined-view
 * convention as `PostWithAuthor` / `NotificationWithActor` — `ProjectMember`
 * only stores a `userId`, a card needs a name/avatar to render.
 */
export interface ProjectMemberWithUser extends ProjectMember {
  user: PostAuthor;
}

export interface ProjectUpdateWithAuthor extends ProjectUpdate {
  author: PostAuthor;
}

/**
 * UI_UX.md §9 lists "Discussion" and "Comments" as separate sections; both
 * would render from the same flat comment-thread data, so this is the one
 * type backing a single consolidated section — see docs/ASSUMPTIONS.md.
 * A sibling of `CommentWithAuthor` (types/feed.ts) rather than a reuse of
 * it, since that type's `postId` field is specifically post-shaped.
 */
export interface ProjectDiscussionComment {
  id: ID;
  projectId: ID;
  author: PostAuthor;
  content: string;
  likesCount: number;
  createdAt: ISODateString;
}
