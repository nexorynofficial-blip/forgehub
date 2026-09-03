import { env } from "../../config/env.js";
import { ConsoleEmailProvider } from "./console.provider.js";
import { EmailService } from "./email.service.js";
import type { EmailProvider } from "./email.types.js";
import { ResendEmailProvider } from "./resend.provider.js";

/**
 * Composition root for email. The `switch` is the only place in the codebase
 * that knows which transport is active — adding a provider means one new case
 * here and a new value in `EMAIL_PROVIDER`'s enum, nothing else. That
 * property is what the Resend integration cost: no service, controller, route
 * or call site changed.
 */
function createProvider(): EmailProvider {
  switch (env.EMAIL_PROVIDER) {
    case "console":
      return new ConsoleEmailProvider();
    case "resend": {
      /*
       * `config/env.ts` already refuses to boot without this key when the
       * resend transport is selected, so reaching the throw is impossible.
       * It stays because the schema's guarantee is not visible to the type
       * system — `RESEND_API_KEY` is `string | undefined` here — and a
       * non-null assertion would silently become wrong if that cross-field
       * rule were ever removed.
       */
      if (!env.RESEND_API_KEY) {
        throw new Error("EMAIL_PROVIDER=resend requires RESEND_API_KEY");
      }
      return new ResendEmailProvider({
        apiKey: env.RESEND_API_KEY,
        from: env.EMAIL_FROM,
      });
    }
  }
}

export const emailService = new EmailService(createProvider());

export { EmailService } from "./email.service.js";
export { ConsoleEmailProvider } from "./console.provider.js";
export { ResendEmailProvider } from "./resend.provider.js";
export type { EmailMessage, EmailProvider } from "./email.types.js";
