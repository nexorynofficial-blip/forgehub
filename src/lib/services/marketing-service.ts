import type {
  ActivityItem,
  FeaturedBuilder,
  FeaturedCommunity,
  Testimonial,
} from "@/types";
import { mockFeaturedBuilders } from "@/lib/mock/builders";
import { mockTestimonials } from "@/lib/mock/testimonials";
import { getCommunities } from "@/lib/services/community-service";

/**
 * The public landing page.
 *
 * This is the one place where fixtures legitimately survive, and each one is
 * classified below. The rule applied throughout: **illustrative marketing
 * copy may be curated; system metrics and activity may not.** A quote in a
 * testimonial card is understood as marketing. A number labelled "Builders" is
 * understood as a fact about the platform, and inventing it is not on.
 */

/**
 * **Static marketing content — intentionally curated.**
 *
 * Testimonials are copy, not data. No backend models them, none should, and a
 * CMS would own them in production. Kept as-is.
 */
export async function getTestimonials(): Promise<Testimonial[]> {
  return mockTestimonials;
}

/**
 * **Static marketing content — decorative.**
 *
 * The floating glass cards in the hero. They are `aria-hidden`, carry no
 * counters or claims, and exist to give the hero depth. There is no "featured
 * builders" endpoint and it would be a product decision to add one, so these
 * stay illustrative rather than being dressed up as a real selection.
 */
export async function getFeaturedBuilders(): Promise<FeaturedBuilder[]> {
  return mockFeaturedBuilders;
}

/**
 * Real data: `GET /communities`.
 *
 * Community discovery is public and unauthenticated, so the landing page can
 * show genuine communities with genuine member counts. This one needed no
 * backend addition — only for someone to call it.
 */
export async function getFeaturedCommunities(limit = 4): Promise<FeaturedCommunity[]> {
  const page = await getCommunities({ limit });
  return page.items.map((community) => ({
    id: community.id,
    name: community.name,
    memberCount: community.memberCount,
    category: community.category,
  }));
}

/**
 * **Unavailable — no backend endpoint exists.**
 *
 * There is no public activity stream. This component renders on the landing
 * page *and* as the signed-in dashboard's activity widget, where a fixture
 * would be presenting invented events as the viewer's own network activity.
 *
 * Returns empty; both surfaces render an unavailable state.
 */
export async function getRecentActivity(): Promise<ActivityItem[]> {
  return [];
}
