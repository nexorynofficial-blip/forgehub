"use client";

import { useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { ThemeProvider } from "next-themes";
import { MotionConfig } from "framer-motion";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { AuthProvider } from "@/providers/auth-provider";
import { SocketProvider } from "@/providers/socket-provider";

/**
 * Root client-side provider tree. Kept as one composed component so
 * `app/layout.tsx` (a server component) only needs one import, and so new
 * providers have a single, obvious place to register.
 *
 * - ThemeProvider: dark-only for now (UI_UX.md §2 "Dark First"; no light
 *   token values exist yet, so `enableSystem` stays off until the Settings →
 *   Appearance phase defines them — see docs/ASSUMPTIONS.md).
 * - QueryClientProvider: one QueryClient per browser session, created lazily
 *   so it survives re-renders but not page reloads.
 * - MotionConfig: `reducedMotion="user"` makes every Framer Motion animation
 *   in the app automatically respect prefers-reduced-motion.
 * - AuthProvider: owns session identity. Sits inside QueryClientProvider
 *   because it clears the query cache on sign-out, and outside everything
 *   that renders, because route guards read its status.
 * - SocketProvider: the Socket.IO connection and the event → cache mapping.
 *   Inside AuthProvider because it connects only once a session exists and
 *   tears the socket down on sign-out; inside QueryClientProvider because
 *   every realtime event lands as a narrow cache update.
 */
export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            retry: 1,
          },
        },
      }),
  );

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider
        attribute="data-theme"
        defaultTheme="dark"
        enableSystem={false}
        forcedTheme="dark"
      >
        <MotionConfig reducedMotion="user">
          <AuthProvider>
            <SocketProvider>
              <TooltipProvider delayDuration={200}>
                {children}
                <Toaster />
              </TooltipProvider>
            </SocketProvider>
          </AuthProvider>
        </MotionConfig>
      </ThemeProvider>
      {process.env.NODE_ENV === "development" && (
        <ReactQueryDevtools initialIsOpen={false} />
      )}
    </QueryClientProvider>
  );
}
