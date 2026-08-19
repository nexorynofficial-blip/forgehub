import type { EntityType, Prisma } from "@prisma/client";
import type { Request } from "express";

import { insertAuditLog } from "../repositories/audit.repository.js";
import { logger } from "./logger.js";

/**
 * Security audit trail (BACKEND_TRD.md §29, BACKEND_ARCHITECTURE.md §26).
 *
 * Thin orchestration over `repositories/audit.repository.ts` — this module
 * decides *what* is worth auditing and guarantees the write can never break
 * the request; the repository decides *how* it is stored.
 */

/**
 * Audited verbs. Free-form strings in the database (so new actions need no
 * migration), but centralized here so they cannot drift into typos.
 */
export const AuditAction = {
  USER_REGISTERED: "USER_REGISTERED",
  USER_LOGIN: "USER_LOGIN",
  USER_LOGIN_FAILED: "USER_LOGIN_FAILED",
  USER_LOGOUT: "USER_LOGOUT",
  ACCOUNT_LOCKED: "ACCOUNT_LOCKED",
  TERMS_ACCEPTED: "TERMS_ACCEPTED",

  EMAIL_VERIFICATION_SENT: "EMAIL_VERIFICATION_SENT",
  EMAIL_VERIFIED: "EMAIL_VERIFIED",

  PASSWORD_CHANGED: "PASSWORD_CHANGED",
  PASSWORD_RESET_REQUESTED: "PASSWORD_RESET_REQUESTED",
  PASSWORD_RESET_COMPLETED: "PASSWORD_RESET_COMPLETED",

  TOKEN_REFRESHED: "TOKEN_REFRESHED",
  REFRESH_TOKEN_REUSE_DETECTED: "REFRESH_TOKEN_REUSE_DETECTED",
  SESSION_REVOKED: "SESSION_REVOKED",
  ALL_SESSIONS_REVOKED: "ALL_SESSIONS_REVOKED",

  TWO_FACTOR_ENROLLMENT_STARTED: "TWO_FACTOR_ENROLLMENT_STARTED",
  TWO_FACTOR_ENABLED: "TWO_FACTOR_ENABLED",
  TWO_FACTOR_DISABLED: "TWO_FACTOR_DISABLED",
  TWO_FACTOR_CHALLENGE_FAILED: "TWO_FACTOR_CHALLENGE_FAILED",
  TWO_FACTOR_BACKUP_CODE_USED: "TWO_FACTOR_BACKUP_CODE_USED",
} as const;

export type AuditActionValue = (typeof AuditAction)[keyof typeof AuditAction];

/** Where the request came from. Captured for every security-sensitive event. */
export interface AuditContext {
  ipAddress: string | null;
  userAgent: string | null;
}

export function auditContextFromRequest(req: Request): AuditContext {
  return {
    ipAddress: req.ip ?? null,
    // Cap the stored value: a hostile client can send a multi-kilobyte header.
    userAgent: req.get("user-agent")?.slice(0, 512) ?? null,
  };
}

export interface AuditEvent extends AuditContext {
  actorId: string | null;
  action: AuditActionValue;
  targetType?: EntityType;
  targetId?: string;
  /**
   * Additional detail. Must never contain credentials — no passwords, tokens,
   * TOTP secrets, or backup codes.
   */
  metadata?: Prisma.InputJsonValue;
}

/**
 * Writes an audit record. Never throws.
 *
 * A failed audit write is logged and swallowed: losing one row is bad, but
 * failing a successful login because the audit insert timed out is worse. The
 * failure itself is loud in the log stream so it cannot pass unnoticed.
 */
export async function recordAuditEvent(event: AuditEvent): Promise<void> {
  try {
    await insertAuditLog({
      actorId: event.actorId,
      action: event.action,
      targetType: event.targetType ?? null,
      targetId: event.targetId ?? null,
      metadata: event.metadata ?? null,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
    });
  } catch (error) {
    logger.error({ err: error, action: event.action }, "Failed to write audit log");
  }
}
