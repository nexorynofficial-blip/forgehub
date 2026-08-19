import type {
  ActivityItem,
  FeaturedBuilder,
  FeaturedCommunity,
  PlatformStats,
  Testimonial,
} from "@/types";
import { mockActivity } from "@/lib/mock/activity";
import { mockFeaturedBuilders } from "@/lib/mock/builders";
import { mockFeaturedCommunities } from "@/lib/mock/communities";
import { mockPlatformStats } from "@/lib/mock/stats";
import { mockTestimonials } from "@/lib/mock/testimonials";

/** Placeholder services for the public landing page. Real endpoints would
 * plausibly be Analytics API (stats), Feed API (activity), and Community
 * API (featured communities) per TRD.md §5. */

export async function getTestimonials(): Promise<Testimonial[]> {
  return mockTestimonials;
}

export async function getPlatformStats(): Promise<PlatformStats> {
  return mockPlatformStats;
}

export async function getRecentActivity(): Promise<ActivityItem[]> {
  return mockActivity;
}

export async function getFeaturedBuilders(): Promise<FeaturedBuilder[]> {
  return mockFeaturedBuilders;
}

export async function getFeaturedCommunities(): Promise<FeaturedCommunity[]> {
  return mockFeaturedCommunities;
}
