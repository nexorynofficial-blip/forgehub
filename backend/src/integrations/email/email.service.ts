import { env } from "../../config/env.js";
import { logger } from "../../utils/logger.js";
import type { EmailProvider } from "./email.types.js";

/**
 * Transactional email the auth flows depend on (BACKEND_TRD.md §26).
 *
 * Services call these methods, never a provider directly. Every method
 * swallows transport failures after logging them: a mail outage must not
 * fail a registration that already committed, and must never be observable
 * to the caller in a way that reveals whether an address exists.
 */
export class EmailService {
  constructor(private readonly provider: EmailProvider) {}

  get providerName(): string {
    return this.provider.name;
  }

  private link(path: string, token: string): string {
    const url = new URL(path, env.APP_URL);
    url.searchParams.set("token", token);
    return url.toString();
  }

  /** Logs the failure without the recipient or any token. */
  private async deliver(to: string, subject: string, text: string): Promise<void> {
    try {
      await this.provider.send({ to, subject, text });
    } catch (error) {
      logger.error(
        { err: error, provider: this.provider.name, subject },
        "Email delivery failed",
      );
    }
  }

  async sendVerificationEmail(
    to: string,
    options: { displayName: string; token: string },
  ): Promise<void> {
    const url = this.link("/verify-email", options.token);

    await this.deliver(
      to,
      "Verify your ForgeHub email address",
      [
        `Hi ${options.displayName},`,
        "",
        "Confirm your email address to activate your ForgeHub account:",
        "",
        `  ${url}`,
        "",
        `This link expires in ${env.EMAIL_VERIFICATION_EXPIRES}.`,
        "If you did not create a ForgeHub account, you can ignore this email.",
      ].join("\n"),
    );
  }

  async sendPasswordResetEmail(
    to: string,
    options: { displayName: string; token: string },
  ): Promise<void> {
    const url = this.link("/reset-password", options.token);

    await this.deliver(
      to,
      "Reset your ForgeHub password",
      [
        `Hi ${options.displayName},`,
        "",
        "We received a request to reset your ForgeHub password:",
        "",
        `  ${url}`,
        "",
        `This link expires in ${env.PASSWORD_RESET_EXPIRES} and can be used once.`,
        "If you did not request a reset, no action is needed — your password is unchanged.",
      ].join("\n"),
    );
  }

  /**
   * Sent after a security-relevant change (password updated, 2FA toggled) so
   * the account owner learns about it even if the actor was not them.
   */
  async sendSecurityAlertEmail(
    to: string,
    options: { displayName: string; event: string },
  ): Promise<void> {
    await this.deliver(
      to,
      "ForgeHub security alert",
      [
        `Hi ${options.displayName},`,
        "",
        `A security-sensitive change was made to your account: ${options.event}.`,
        "",
        "If this was not you, reset your password immediately and review your",
        "active sessions in Settings.",
      ].join("\n"),
    );
  }
}
