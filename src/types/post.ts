import type { ID, ISODateString } from "./common";

/** PRD.md §4.5 Posts */
export type PostType =
  | "text"
  | "image"
  | "video"
  | "code"
  | "markdown"
  | "poll"
  | "update"
  | "milestone"
  | "announcement";

export interface PollOption {
  id: ID;
  label: string;
  voteCount: number;
}

export interface Poll {
  question: string;
  options: PollOption[];
  closesAt: ISODateString | null;
}

export interface CodeSnippet {
  language: string;
  code: string;
}

export interface Post {
  id: ID;
  authorId: ID;
  projectId: ID | null;
  type: PostType;
  content: string;
  mediaUrls: string[];
  codeSnippet: CodeSnippet | null;
  poll: Poll | null;
  likesCount: number;
  commentsCount: number;
  createdAt: ISODateString;
}

export interface Comment {
  id: ID;
  postId: ID;
  authorId: ID;
  parentCommentId: ID | null;
  content: string;
  likesCount: number;
  createdAt: ISODateString;
}
