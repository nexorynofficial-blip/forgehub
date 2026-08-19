import type { ContributionDay } from "@/types";

function hashSeed(input: string): number {
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }
  return hash || 1;
}

/** Small seeded PRNG (mulberry32) — deterministic per seed, unlike
 * Math.random(), which is required here since this data is only ever read
 * client-side (useQuery, matching every other service in this codebase) but
 * still needs to render identically across repeated fetches/renders. */
function mulberry32(seed: number) {
  let state = seed;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WEEKS = 53;

/** GitHub-style contribution heatmap (UI_UX.md §8), seeded per username so
 * every profile shows a distinct but stable pattern. */
export function getMockContributionGraph(username: string): ContributionDay[] {
  const random = mulberry32(hashSeed(username));
  const totalDays = WEEKS * 7;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const days: ContributionDay[] = [];
  for (let i = totalDays - 1; i >= 0; i--) {
    const date = new Date(today);
    date.setDate(date.getDate() - i);
    const roll = random();
    const count =
      roll > 0.78 ? 4 : roll > 0.62 ? 3 : roll > 0.48 ? 2 : roll > 0.35 ? 1 : 0;
    days.push({ date: date.toISOString(), count });
  }
  return days;
}
