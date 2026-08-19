import { env, isProduction } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { EmailMessage, EmailProvider } from "./email.types.js";

/**
 * Development transport: "delivers" a message by printing it to stdout.
 *
 * Note the deliberate use of `process.stdout` rather than the Pino logger.
 * Verification and reset links contain single-use tokens, and TRD §30 forbids
 * those from entering the log stream that ships to an aggregator. Writing
 * directly to the console keeps the local developer experience (you can click
 * the link) without ever putting a token into structured logs.
 *
 * It refuses to emit anything in production, where printing a reset link to
 * container logs would be a genuine credential leak.
 */
export class ConsoleEmailProvider implements EmailProvider {
  readonly name = "console";

  async send(message: EmailMessage): Promise<void> {
    if (isProduction) {
      logger.error(
        { to: "[REDACTED]", subject: message.subject },
        "Console email provider is not usable in production — message dropped",
      );
      return Promise.resolve();
    }

    const divider = "─".repeat(72);
    process.stdout.write(
      [
        "",
        divider,
        "  SIMULATED EMAIL (development transport — nothing was actually sent)",
        divider,
        `  From:    ${env.EMAIL_FROM}`,
        `  To:      ${message.to}`,
        `  Subject: ${message.subject}`,
        divider,
        message.text,
        divider,
        "",
      ].join("\n"),
    );

    return Promise.resolve();
  }
}
