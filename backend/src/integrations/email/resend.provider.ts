import type { EmailMessage, EmailProvider } from "./email.types.js";

/**
 * Production transport: Resend's HTTP API.
 *
 * Implemented against `fetch` rather than the `resend` SDK. The entire
 * integration is one POST to one endpoint with a bearer token, and Node 22
 * ships `fetch` natively — an SDK would add a dependency, a release cadence,
 * and a transitive tree to save nothing. It also keeps the test boundary
 * honest: a stubbed `fetch` exercises the same code path production runs,
 * where a stubbed SDK client would only prove the SDK was called.
 *
 * Nothing here logs. `EmailService.deliver` is the single place that reports
 * a transport failure, and it deliberately records the subject and provider
 * but never the recipient or the body — verification and reset bodies carry
 * single-use tokens (TRD §30). This class therefore throws with a message
 * built only from Resend's own status and error fields, never from the
 * message it was asked to send.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Beyond this, a hung mail API is failing rather than working slowly. */
const DEFAULT_TIMEOUT_MS = 10_000;

export interface ResendProviderOptions {
  apiKey: string;
  /** The verified sender. Resend rejects any address it has not verified. */
  from: string;
  endpoint?: string;
  timeoutMs?: number;
}

/** The error envelope Resend returns on a 4xx/5xx. Both fields are optional. */
interface ResendErrorBody {
  name?: unknown;
  message?: unknown;
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend";

  private readonly apiKey: string;
  private readonly from: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  constructor(options: ResendProviderOptions) {
    this.apiKey = options.apiKey;
    this.from = options.from;
    this.endpoint = options.endpoint ?? RESEND_ENDPOINT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async send(message: EmailMessage): Promise<void> {
    const response = await this.post(message);

    if (!response.ok) {
      throw new Error(
        `Resend rejected the message (${response.status}): ${await describe(response)}`,
      );
    }
  }

  private async post(message: EmailMessage): Promise<Response> {
    // `AbortSignal.timeout` is native from Node 18; no timer to clean up.
    const signal = AbortSignal.timeout(this.timeoutMs);

    try {
      return await fetch(this.endpoint, {
        method: "POST",
        signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: this.from,
          // Resend accepts a string or an array; the array form is
          // unambiguous and is what the API documents.
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html !== undefined ? { html: message.html } : {}),
        }),
      });
    } catch (error) {
      // A network fault or the abort above. Rethrown with the provider named
      // so `EmailService` logs which transport failed, and with `cause` kept
      // for the stack — the original carries no message content either.
      throw new Error("Resend request failed before a response was received", {
        cause: error,
      });
    }
  }
}

/**
 * Resend's own error text, and nothing else.
 *
 * A failed response body describes the *request's* fault ("domain is not
 * verified", "invalid API key") and never echoes the message, so it is safe
 * to surface. The fallback exists because an infrastructure 502 from a proxy
 * in front of the API is HTML, not JSON.
 */
async function describe(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as ResendErrorBody;
    const detail = typeof body.message === "string" ? body.message : null;
    const kind = typeof body.name === "string" ? body.name : null;

    if (detail && kind) return `${kind}: ${detail}`;
    if (detail) return detail;
    if (kind) return kind;
  } catch {
    // Fall through — a non-JSON body tells us nothing worth reporting.
  }

  return response.statusText || "no error detail returned";
}
