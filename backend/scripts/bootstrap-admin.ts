import { parseArgs } from "node:util";

import { PrismaClient, UserRole } from "@prisma/client";

/**
 * Promotes the **first** platform administrator.
 *
 * ## Why this exists
 *
 * Registration always assigns `member`, and the only in-application route to
 * `platform_admin` is `PATCH /admin/users/:id/role`, which requires a caller
 * who is already one. The development seed is the only other place a role is
 * set, and it refuses to run in production by design. A fresh production
 * database therefore has no administrator and no supported way to acquire
 * one — the moderation queue, user management and audit log are unreachable.
 *
 * This closes that gap, and nothing more.
 *
 * ## Why it is not a general role tool
 *
 * It refuses to run once any platform admin exists. That single rule is what
 * keeps it a bootstrap rather than a back door: after the first grant, every
 * subsequent role change goes through the audited, authenticated, authorized
 * API, where it is attributable to a person. A CLI that could promote anyone
 * at any time would be a permanent unaudited privilege-escalation path living
 * in the repository.
 *
 * It also never creates an account and never sets a password. The target must
 * already have registered through the normal flow, so the credential is one
 * only they have ever known.
 *
 * ## Why it is not an HTTP endpoint
 *
 * An endpoint that grants platform admin is reachable by anyone who can reach
 * the API. This requires a shell on a machine holding `DATABASE_URL` — the
 * same access migrations already need, and a strictly higher bar than a
 * request.
 *
 * ## Running it
 *
 *   npm run admin:bootstrap -- --email founder@example.com
 *
 * From a checkout with `DATABASE_URL` pointing at the target database. Not
 * from the runtime image: `scripts/` is not copied into it, for the same
 * reason the Prisma CLI is not.
 */

const USAGE = `
Promote the first platform administrator.

  npm run admin:bootstrap -- --email <address>

Options
  --email <address>   The registered user to promote. Required.
  --help              Show this message.

Refuses to run if a platform admin already exists. Every later role change
belongs to the admin API, which audits it against a signed-in actor.
`.trim();

/** Written to the audit log so the out-of-band grant is not invisible. */
const AUDIT_ACTION = "ROLE_CHANGED";

type Outcome = { ok: true; message: string } | { ok: false; message: string };

async function bootstrap(prisma: PrismaClient, email: string): Promise<Outcome> {
  /*
   * Serializable, because the guard *is* the operation. "No admin exists" read
   * at Read Committed could be true in two concurrent runs, and both would
   * promote — producing exactly the several-unaudited-admins outcome the
   * refusal is meant to prevent. The script runs once, by hand, so the
   * strictest isolation costs nothing.
   */
  return prisma.$transaction(
    async (tx): Promise<Outcome> => {
      const existingAdmin = await tx.user.findFirst({
        where: { role: UserRole.platform_admin },
        select: { email: true, username: true },
      });

      if (existingAdmin) {
        return {
          ok: false,
          message:
            `A platform admin already exists (${existingAdmin.username}). ` +
            "Refusing to run.\n\n" +
            "This command only bootstraps the first one. Promote further " +
            "admins through the admin API, which records who did it.",
        };
      }

      const target = await tx.user.findUnique({
        where: { email },
        select: { id: true, username: true, role: true, status: true },
      });

      if (!target) {
        return {
          ok: false,
          message:
            `No user is registered with ${email}.\n\n` +
            "This command promotes an existing account — it never creates " +
            "one, and never sets a password. Sign up through the app first.",
        };
      }

      /*
       * The role is in the `where` clause rather than compared beforehand, on
       * the same principle as `admin.repository.ts`: a read-then-write can be
       * overtaken between the two statements.
       */
      const changed = await tx.user.updateMany({
        where: { id: target.id, role: target.role },
        data: { role: UserRole.platform_admin },
      });

      if (changed.count === 0) {
        return {
          ok: false,
          message: `${target.username}'s role changed while this ran. Nothing was written.`,
        };
      }

      await tx.auditLog.create({
        data: {
          // Null actor: this grant came from an operator with database access,
          // not from a signed-in user. The audit trail should say so rather
          // than attribute it to the account being promoted.
          actorId: null,
          action: AUDIT_ACTION,
          targetType: "user",
          targetId: target.id,
          metadata: {
            from: target.role,
            to: UserRole.platform_admin,
            via: "admin:bootstrap",
          },
          ipAddress: null,
          userAgent: null,
        },
      });

      const warning =
        target.status === "active"
          ? ""
          : `\n\nNote: this account's status is "${target.status}", so it cannot sign in until that is lifted.`;

      return {
        ok: true,
        message: `Promoted ${target.username} (${email}) from ${target.role} to platform_admin.${warning}`,
      };
    },
    { isolationLevel: "Serializable" },
  );
}

async function main(): Promise<void> {
  let email: string | undefined;

  try {
    const { values } = parseArgs({
      options: {
        email: { type: "string" },
        help: { type: "boolean", default: false },
      },
      // A typo should be an error, not a silently ignored argument on a
      // command that grants platform admin.
      strict: true,
    });

    if (values.help) {
      process.stdout.write(`${USAGE}\n`);
      return;
    }

    email = values.email?.trim().toLowerCase();
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  if (!email) {
    process.stderr.write(`--email is required.\n\n${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();

  try {
    const outcome = await bootstrap(prisma, email);
    const stream = outcome.ok ? process.stdout : process.stderr;
    stream.write(`${outcome.message}\n`);
    if (!outcome.ok) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

await main();
