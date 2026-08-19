import { AppSidebar, MobileSidebarDrawer } from "@/components/app/app-sidebar";
import { AppTopbar } from "@/components/app/app-topbar";
import { MobileBottomNav } from "@/components/app/mobile-bottom-nav";

/** UI_UX.md §7 Dashboard shell: persistent sidebar + topbar, wrapping every
 * authenticated route (dashboard, profile, feed, projects, communities,
 * messages, settings, admin). See docs/ARCHITECTURE.md §4. */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen">
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
  );
}
