"use client";

import { useQuery } from "@tanstack/react-query";
import { motion } from "framer-motion";

import { getFeaturedBuilders } from "@/lib/services/marketing-service";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

const POSITIONS = [
  { className: "left-[2%] top-[8%]", duration: 6, delay: 0 },
  { className: "right-[4%] top-[20%]", duration: 7, delay: 0.4 },
  { className: "left-[10%] bottom-[12%]", duration: 6.5, delay: 0.8 },
  { className: "right-[10%] bottom-[6%]", duration: 5.5, delay: 1.2 },
];

/** UI_UX.md §6 "Floating Builder Cards" — decorative, desktop only. */
export function FloatingBuilderCards() {
  const { data: builders } = useQuery({
    queryKey: ["featuredBuilders"],
    queryFn: getFeaturedBuilders,
  });

  if (!builders) return null;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 hidden lg:block"
    >
      {POSITIONS.map((pos, index) => {
        const builder = builders[index];
        if (!builder) return null;
        return (
          <motion.div
            key={builder.id}
            className={`glass absolute flex items-center gap-3 rounded-md px-4 py-3 shadow-[var(--shadow-floating)] ${pos.className}`}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: [0, -10, 0] }}
            transition={{
              opacity: { duration: 0.6, delay: 0.6 + pos.delay },
              y: {
                duration: pos.duration,
                delay: 1,
                repeat: Infinity,
                ease: "easeInOut",
              },
            }}
          >
            <Avatar className="size-9">
              <AvatarFallback>{builder.name.charAt(0)}</AvatarFallback>
            </Avatar>
            <div>
              <p className="text-foreground text-sm font-medium">{builder.name}</p>
              <p className="text-muted-foreground text-xs">{builder.role}</p>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
}
