import type { ModerationStatus, UserRole } from "@prisma/client";

/**
 * Request-scoped identity, attached by `auth.middleware.ts` after a token has
 * been verified *and* the user re-read from the database.
 *
 * Deliberately not the full Prisma `User`: nothing downstream should be able
 * to reach `passwordHash` through `req.user`, so the shape only carries what
 * authorization decisions and audit records actually need.
 */
export interface AuthenticatedUser {
  id: string;
  email: string;
  username: string;
  displayName: string;
  role: UserRole;
  status: ModerationStatus;
  emailVerified: boolean;
  /** The session the presented access token belongs to. */
  sessionId: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /**
       * Present only after `requireAuth` (always) or `optionalAuth` (when a
       * valid token was supplied). Never populated from client-supplied
       * body/query values — identity comes from the verified token alone.
       */
      user?: AuthenticatedUser;
    }
  }
}
