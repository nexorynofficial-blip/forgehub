import { env } from "../../config/env.js";
import { ConsoleEmailProvider } from "./console.provider.js";
import { EmailService } from "./email.service.js";
import type { EmailProvider } from "./email.types.js";

/**
 * Composition root for email. The `switch` is the only place in the codebase
 * that knows which transport is active — adding a real provider means one new
 * case here and a new value in `EMAIL_PROVIDER`'s enum, nothing else.
 */
function createProvider(): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case "console":
      return new ConsoleEmailProvider();
  }
}

export const emailService = new EmailService(createProvider());

export { EmailService } from "./email.service.js";
export type { EmailMessage, EmailProvider } from "./email.types.js";
