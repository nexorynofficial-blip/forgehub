"use client";

import { motion } from "framer-motion";

import { cn } from "@/lib/utils";
import { getPasswordStrength } from "@/lib/password-strength";

const STRENGTH_META = {
  empty: { label: "", widthPercent: 0, color: "bg-transparent" },
  weak: { label: "Weak", widthPercent: 33, color: "bg-danger" },
  fair: { label: "Fair", widthPercent: 66, color: "bg-accent" },
  strong: { label: "Strong", widthPercent: 100, color: "bg-success" },
} as const;

export function PasswordStrengthMeter({ password }: { password: string }) {
  const strength = getPasswordStrength(password);
  const meta = STRENGTH_META[strength];

  if (strength === "empty") return null;

  return (
    <div className="mt-2 flex items-center gap-2">
      <div className="bg-muted h-1.5 flex-1 overflow-hidden rounded-full">
        <motion.div
          className={cn("h-full rounded-full", meta.color)}
          initial={{ width: 0 }}
          animate={{ width: `${meta.widthPercent}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </div>
      <span className="text-muted-foreground w-10 shrink-0 text-xs">{meta.label}</span>
    </div>
  );
}
