/**
 * Sample data for the landing-page hero preview.
 *
 * These are **one fictional builder's numbers**, not platform statistics. The
 * distinction matters: a stats band claiming "12,000 builders" would be a
 * factual claim about ForgeHub that nothing backs up, which is why the old one
 * was removed. A dashboard belonging to a made-up account shows what the
 * product looks like in use, and the surrounding UI says "sample" out loud.
 *
 * The names match the projects that already appear in `posts.ts` and
 * `timeline.ts` — the same fictional world across the whole site, so a visitor
 * who reads the feed further down recognises what they saw at the top.
 */

export interface WeeklyUpdate {
  /** Week label, oldest first. Only the ends are drawn — twelve labels on a
   * chart this size collide, and the shape is the point, not the calendar. */
  label: string;
  count: number;
}

/**
 * Updates shipped per week over a quarter. Rising, but not a straight line —
 * a monotonic climb reads as decoration rather than as someone's real quarter,
 * and the dips are the honest part of building in public.
 */
export const WEEKLY_UPDATES: WeeklyUpdate[] = [
  { label: "12 weeks ago", count: 3 },
  { label: "11 weeks ago", count: 6 },
  { label: "10 weeks ago", count: 4 },
  { label: "9 weeks ago", count: 9 },
  { label: "8 weeks ago", count: 8 },
  { label: "7 weeks ago", count: 7 },
  { label: "6 weeks ago", count: 12 },
  { label: "5 weeks ago", count: 10 },
  { label: "4 weeks ago", count: 15 },
  { label: "3 weeks ago", count: 14 },
  { label: "2 weeks ago", count: 19 },
  { label: "This week", count: 23 },
];

export interface PreviewProject {
  name: string;
  /** Matches `progressPercent` on a real project — the field the roadmap
   * genuinely computes, so the bar means the same thing here as in the app. */
  progressPercent: number;
  status: string;
}

export const PREVIEW_PROJECTS: PreviewProject[] = [
  { name: "Tidal Notes v2.0", progressPercent: 82, status: "3 of 4 milestones" },
  { name: "Northwind Atlas", progressPercent: 46, status: "Layered maps in review" },
  { name: "Coastline CRM", progressPercent: 100, status: "Shipped" },
];
