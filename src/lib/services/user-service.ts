import type { User } from "@/types";
import { mockCurrentUser } from "@/lib/mock/users";

/**
 * Placeholder for the Profile API (TRD.md §5). Every service in this
 * directory returns a Promise so call sites (React Query hooks, server
 * components) don't change shape when a real `fetch` replaces the mock body.
 *
 * `getCurrentUser`/`updateCurrentUser` return a shallow copy of
 * `mockCurrentUser` rather than the object itself — `updateCurrentUser`
 * mutates it in place (other modules hold a direct reference to
 * `mockCurrentUser` and expect to see updates synchronously, e.g.
 * `resolvePersonById`), but a fresh top-level reference is what tells React
 * Query a refetch actually changed something worth re-rendering for. See
 * docs/ASSUMPTIONS.md (Phase 10).
 */
export async function getCurrentUser(): Promise<User> {
  return { ...mockCurrentUser };
}

export async function updateCurrentUser(patch: Partial<User>): Promise<User> {
  Object.assign(mockCurrentUser, patch);
  return { ...mockCurrentUser };
}

/** No auth backend exists (TRD.md §5) — always succeeds after a simulated
 * delay, same as every `lib/services/auth-service.ts` function. */
export async function changePassword(
  _currentPassword: string,
  _newPassword: string,
): Promise<{ success: true }> {
  return { success: true };
}
