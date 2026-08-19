import type { BadgeProps } from "@/components/ui/badge";
import type { FundingStage, ProjectStatus } from "@/types";

/** Shared status/funding badge labels — originally local to
 * `components/profile/pinned-projects-section.tsx` (Phase 05), extracted
 * here in Phase 07 so the Project Page can use the exact same labels
 * instead of redefining them. */
export const PROJECT_STATUS_META: Record<
  ProjectStatus,
  { label: string; variant: BadgeProps["variant"] }
> = {
  idea: { label: "Idea", variant: "outline" },
  in_progress: { label: "In progress", variant: "primary" },
  beta: { label: "Beta", variant: "secondary" },
  launched: { label: "Launched", variant: "success" },
  archived: { label: "Archived", variant: "outline" },
};

export const PROJECT_FUNDING_META: Record<FundingStage, string> = {
  bootstrapped: "Bootstrapped",
  pre_seed: "Pre-seed",
  seed: "Seed",
  series_a_plus: "Series A+",
  not_seeking: "Not seeking funding",
};
