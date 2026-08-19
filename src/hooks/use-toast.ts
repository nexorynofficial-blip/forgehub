"use client";

import { create } from "zustand";

export interface ToastItem {
  id: string;
  title: string;
  description?: string;
  variant?: "default" | "success" | "danger";
}

interface ToastState {
  toasts: ToastItem[];
  toast: (toast: Omit<ToastItem, "id">) => string;
  dismiss: (id: string) => void;
}

/** Global toast queue. Call `toast(...)` from anywhere; <Toaster /> renders the queue. */
export const useToast = create<ToastState>((set) => ({
  toasts: [],
  toast: ({ title, description, variant = "default" }) => {
    const id = crypto.randomUUID();
    set((state) => ({ toasts: [...state.toasts, { id, title, description, variant }] }));
    return id;
  },
  dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
}));
