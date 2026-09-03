"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient } from "@tanstack/react-query";

import { setSessionExpiredHandler } from "@/lib/api";
import {
  bootstrapSession,
  login as loginRequest,
  logout as logoutRequest,
  signup as signupRequest,
  verifyTwoFactorCode as verifyTwoFactorRequest,
  type LoginResult,
  type SessionUser,
  type SignupResult,
} from "@/lib/services/auth-service";
import type { LoginValues, SignupValues } from "@/lib/validations/auth";

/**
 * The single source of truth for "who is signed in".
 *
 * There is deliberately no second, persisted store: the access token is
 * memory-only by design, so a rehydrated Zustand slice claiming
 * "authenticated" after a reload would be asserting something it cannot back
 * up. Identity lives here, for exactly as long as the tab does.
 */
export type AuthStatus = "loading" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  isAuthenticated: boolean;
  login: (values: LoginValues) => Promise<LoginResult>;
  verifyTwoFactor: (code: string) => Promise<SessionUser>;
  signup: (values: SignupValues) => Promise<SignupResult>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<SessionUser | null>;
  /**
   * Folds a successful profile mutation back into the session user.
   *
   * `/users/me` and `/auth/*` return two different views of the same person,
   * and the shell (avatar, display name, the `@handle` in the user menu, every
   * `routes.profile(username)` link) renders from the session one. Without
   * this, saving the account form would update the settings page and leave the
   * sidebar showing the old name until the next reload.
   *
   * A patch rather than a whole user: the caller has a `CurrentUserView`, which
   * is a superset with different owner-only fields, and only the keys the two
   * views share are meaningful here.
   */
  updateSessionUser: (patch: Partial<SessionUser>) => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<AuthStatus>("loading");
  const [user, setUser] = useState<SessionUser | null>(null);

  /**
   * Clears cached server data on sign-out.
   *
   * `clear()` rather than `invalidateQueries()`: invalidation leaves the old
   * values readable while a refetch runs, which would flash the previous
   * user's data. Only logout and session-expiry do this — an ordinary token
   * refresh must not throw the cache away.
   */
  const resetSession = useCallback(() => {
    setUser(null);
    setStatus("unauthenticated");
    queryClient.clear();
  }, [queryClient]);

  /**
   * The API client detects a failed refresh; this is how it tells React.
   *
   * A plain callback rather than an import keeps the dependency one-way
   * (provider → client) and avoids a cycle. `resetSession` is stable — its
   * only dependency is the QueryClient — so this registers once in practice.
   */
  useEffect(() => {
    setSessionExpiredHandler(resetSession);
    return () => {
      setSessionExpiredHandler(null);
    };
  }, [resetSession]);

  /**
   * Startup bootstrap.
   *
   * Mandatory, not an optimisation: after a reload the access token is gone
   * and the refresh cookie is the only evidence the session survived. A 401
   * here is the normal "not signed in" answer, never an error to surface.
   */
  useEffect(() => {
    let cancelled = false;

    void bootstrapSession()
      .then((session) => {
        if (cancelled) return;
        if (session) {
          setUser(session);
          setStatus("authenticated");
        } else {
          setUser(null);
          setStatus("unauthenticated");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setUser(null);
        setStatus("unauthenticated");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (values: LoginValues): Promise<LoginResult> => {
    const result = await loginRequest(values);
    if (result.status === "authenticated") {
      setUser(result.user);
      setStatus("authenticated");
    }
    // The 2FA branch deliberately leaves status untouched: a user who has not
    // cleared the second factor is not authenticated.
    return result;
  }, []);

  const verifyTwoFactor = useCallback(async (code: string): Promise<SessionUser> => {
    const session = await verifyTwoFactorRequest(code);
    setUser(session);
    setStatus("authenticated");
    return session;
  }, []);

  const signup = useCallback(
    (values: SignupValues): Promise<SignupResult> => signupRequest(values),
    [],
  );

  const logout = useCallback(async () => {
    try {
      await logoutRequest();
    } finally {
      // Runs even if the network call failed — the token is already cleared by
      // the service, so the UI must not keep claiming a session.
      resetSession();
    }
  }, [resetSession]);

  const refreshSession = useCallback(async (): Promise<SessionUser | null> => {
    const session = await bootstrapSession();
    if (session) {
      setUser(session);
      setStatus("authenticated");
    } else {
      resetSession();
    }
    return session;
  }, [resetSession]);

  const updateSessionUser = useCallback((patch: Partial<SessionUser>) => {
    setUser((current) => (current ? { ...current, ...patch } : current));
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      isAuthenticated: status === "authenticated",
      login,
      verifyTwoFactor,
      signup,
      logout,
      refreshSession,
      updateSessionUser,
    }),
    [
      status,
      user,
      login,
      verifyTwoFactor,
      signup,
      logout,
      refreshSession,
      updateSessionUser,
    ],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside <AuthProvider>");
  }
  return context;
}
