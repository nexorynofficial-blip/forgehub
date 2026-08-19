import type { LoginValues, SignupValues } from "@/lib/validations/auth";

/** Frontend-only stand-ins for the Authentication API (TRD.md §5). Every
 * call resolves after a short simulated delay so forms exercise real
 * loading states; nothing is persisted or actually authenticated. The
 * unused parameters mirror the real API's expected shape for when a fetch
 * call replaces the body. */

const NETWORK_DELAY_MS = 900;

function simulateRequest<T>(result: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(result), NETWORK_DELAY_MS));
}

export async function login(_values: LoginValues): Promise<{ success: true }> {
  return simulateRequest({ success: true as const });
}

export async function signup(_values: SignupValues): Promise<{ success: true }> {
  return simulateRequest({ success: true as const });
}

export async function requestPasswordReset(_email: string): Promise<{ success: true }> {
  return simulateRequest({ success: true as const });
}

export async function resendVerificationEmail(
  _email: string,
): Promise<{ success: true }> {
  return simulateRequest({ success: true as const });
}

export async function verifyTwoFactorCode(_code: string): Promise<{ success: true }> {
  return simulateRequest({ success: true as const });
}
