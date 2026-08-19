/** Frontend-wide API contract shapes, anticipating the TRD §5 REST APIs. */

export type ID = string;

export type ISODateString = string;

export interface Paginated<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

export interface ApiResponse<T> {
  data: T;
  error: null;
}

export interface ApiError {
  data: null;
  error: {
    message: string;
    code: string;
  };
}

/** PRD.md §4.13 User Roles */
export type UserRole =
  | "guest"
  | "member"
  | "verified_builder"
  | "moderator"
  | "community_admin"
  | "platform_admin";
