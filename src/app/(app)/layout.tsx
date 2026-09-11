import { AppSidebar, MobileSidebarDrawer } from "@/components/app/app-sidebar";
import { AppTopbar } from "@/components/app/app-topbar";
import { MobileBottomNav } from "@/components/app/mobile-bottom-nav";
import { RequireAuth } from "@/components/auth/auth-gate";
import { Aurora } from "@/components/marketing/aurora";

/** UI_UX.md §7 Dashboard shell: persistent sidebar + topbar, wrapping every
 * authenticated route (dashboard, profile, feed, projects, communities,
 * messages, settings, admin). See docs/ARCHITECTURE.md §4.
 *
 * `RequireAuth` wraps the shell rather than sitting inside `<main>`: the
 * sidebar and topbar are authenticated surfaces too, and rendering them for a
 * signed-out visitor would leak the app's structure before the redirect.
 *
 * The bloom carries the marketing site's atmosphere across the sign-in
 * boundary, at `subtle` — an app is a working surface, and a glow strong
 * enough to be the point of a landing page is a distraction behind a table of
 * someone's projects. It is `fixed` so it stays put as the page scrolls
 * rather than smearing down a long feed. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <RequireAuth>
      <div className="relative isolate flex min-h-screen">
        <Aurora intensity="subtle" className="fixed inset-0 -z-10" />
        <AppSidebar />
        <MobileSidebarDrawer />
        <div className="flex min-w-0 flex-1 flex-col">
          <AppTopbar />
          <main id="main-content" className="flex-1 px-4 pb-24 sm:px-6 lg:px-8 lg:pb-10">
            {children}
          </main>
        </div>
        <MobileBottomNav />
      </div>
    </RequireAuth>
  );
}
