import { z } from "zod";

import { cursorPaginationSchema } from "../../utils/pagination.js";
import { usernameParamSchema } from "../users/users.schema.js";

/**
 * Request validation for the social graph (BACKEND_TRD.md §15).
 *
 * Targets are addressed by **username**, not id — that is what the frontend
 * has in hand on a profile page, and it avoids clients passing raw ids around.
 * The authenticated actor always comes from the token, never the payload.
 */

/** `/users/:username/follow`, `/users/:username/block`. */
export const targetUsernameParamSchema = usernameParamSchema;
export type TargetUsernameParam = z.infer<typeof targetUsernameParamSchema>;

/**
 * Followers/following/blocked lists.
 *
 * Cursor rather than offset: these are high-volume and grow at the head, so
 * offset paging would duplicate or skip entries as new follows land
 * mid-scroll (BACKEND_TRD.md §8). Reuses the shared Phase 1 helper.
 */
export const followListQuerySchema = cursorPaginationSchema;
export type FollowListQuery = z.infer<typeof followListQuerySchema>;
