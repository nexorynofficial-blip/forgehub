/**
 * Email provider abstraction (BACKEND_TRD.md §26).
 *
 * Callers depend on this interface, never on a concrete transport, so
 * swapping the development console provider for Resend/SES/Postmark later is
 * a one-line change in `index.ts` and touches no business logic.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  /** Plain-text body. Always populated — HTML is optional enrichment. */
  text: string;
  html?: string;
}

export interface EmailProvider {
  /** Identifies the transport in logs and health output. */
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}
