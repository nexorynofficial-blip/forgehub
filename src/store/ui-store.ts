import { create } from "zustand";

/**
 * Ephemeral, client-only UI state that doesn't belong in React Query
 * (server state) or URL state (route/search params). Feature phases extend
 * this store rather than creating parallel ad-hoc stores.
 */
interface UIState {
  isSidebarOpen: boolean;
  isCommandPaletteOpen: boolean;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setCommandPaletteOpen: (open: boolean) => void;
}

export const useUIStore = create<UIState>((set) => ({
  isSidebarOpen: false,
  isCommandPaletteOpen: false,
  setSidebarOpen: (open) => set({ isSidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
  setCommandPaletteOpen: (open) => set({ isCommandPaletteOpen: open }),
}));
