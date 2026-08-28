import type { UserRole } from "@prisma/client";

import { buildPagination, toPrismaOffset } from "../../utils/pagination.js";
import type { Pagination } from "../../utils/response.js";
import { shouldSearch } from "./search.access.js";
import * as repo from "./search.repository.js";
import type { SearchQuery } from "./search.schema.js";
import type { SearchResultsView } from "./search.types.js";
import {
  emptyGroup,
  toCommunityResult,
  toGroup,
  toPostResult,
  toProjectResult,
  toTagResult,
  toUserResult,
} from "./search.view.js";

/**
 * The SearchService required by BACKEND_ARCHITECTURE.md §24 (Phase 10).
 *
 * §24's requirement is a seam, not a class: *"Create a SearchService
 * abstraction. Frontend calls SearchService, not PostgreSQL directly… Future
 * implementation may replace the underlying engine with Meilisearch,
 * OpenSearch, or Elasticsearch **without changing the API contract**."*
 *
 * This file is that seam. It knows about search *semantics* — which groups a
 * request wants, how a page maps onto each group, what the response looks
 * like — and nothing about how a row is matched. Everything engine-specific
 * lives one layer down in `search.repository.ts`. Swapping PostgreSQL for a
 * dedicated engine replaces that file and leaves this one, the controller, the
 * route, and the response shape untouched, which is exactly what §24 asks for.
 *
 * No new port was introduced. `ports/notification.port.ts` exists because
 * *domain services* had to raise notifications without depending on the
 * notifications module — an inversion between peers. Nothing depends on search
 * except HTTP, so a port here would be a third layer with one implementation
 * and no second caller. The service/repository split already provides the
 * substitution point.
 *
 * Three rules carried from Phases 4–9:
 *
 *   1. **Identity comes from the caller**, never from a parameter. The viewer
 *      below is built by the controller from the verified access token.
 *   2. **Visibility is resolved in SQL**, in the repository, not here.
 *   3. **Projection happens last**, in `search.view.ts`.
 */

/**
 * Who is searching.
 *
 * `role` is accepted so the type matches the `Viewer` every other module
 * passes around, and is then **not used** — ruling D8. It is retained rather
 * than dropped so the controller needs no special case, and so the omission is
 * visible here where a future reader might otherwise reintroduce it.
 */
export interface Viewer {
  id: string | null;
  role: UserRole | null;
}

export const ANONYMOUS: Viewer = { id: null, role: null };

/**
 * Runs a search.
 *
 * Groups are queried **concurrently** — five independent reads with no
 * ordering between them, so serializing would make a search as slow as the sum
 * of its parts rather than the slowest of them. Groups the `type` filter
 * excludes are not queried at all; they appear in the response as empty
 * groups so the shape stays constant (ruling D14).
 *
 * The same `page`/`limit` applies to every group. That is what a grouped
 * response means: page 2 of a search is page 2 of each entity, not page 2 of
 * some interleaved list that would need a cross-entity ranking to define —
 * which ruling D6 forbids inventing.
 */
export async function search(
  viewer: Viewer,
  query: SearchQuery,
): Promise<SearchResultsView> {
  const { skip, take } = toPrismaOffset({ page: query.page, limit: query.limit });
  const page = { skip, take, sort: query.sort };

  // Only the id reaches the repository. The role is dropped here rather than
  // ignored downstream, so there is no argument an admin branch could read.
  const viewerId = viewer.id;

  const wantUsers = shouldSearch("users", query.type);
  const wantProjects = shouldSearch("projects", query.type);
  const wantCommunities = shouldSearch("communities", query.type);
  const wantPosts = shouldSearch("posts", query.type);
  const wantTags = shouldSearch("tags", query.type);

  const [users, projects, communities, posts, tags] = await Promise.all([
    wantUsers ? repo.searchUsers(query.q, viewerId, page) : null,
    wantProjects ? repo.searchProjects(query.q, viewerId, page) : null,
    wantCommunities ? repo.searchCommunities(query.q, viewerId, page) : null,
    wantPosts ? repo.searchPosts(query.q, viewerId, page) : null,
    wantTags ? repo.searchTags(query.q, page) : null,
  ]);

  const paging = (total: number): Pagination =>
    buildPagination({ page: query.page, limit: query.limit }, total);
  const skipped = paging(0);

  const totals = [users, projects, communities, posts, tags]
    .map((group) => group?.total ?? 0)
    .reduce((sum, total) => sum + total, 0);

  return {
    query: query.q,
    type: query.type,
    sort: query.sort,
    users:
      users === null
        ? emptyGroup(skipped)
        : toGroup(users, paging(users.total), toUserResult),
    projects:
      projects === null
        ? emptyGroup(skipped)
        : toGroup(projects, paging(projects.total), toProjectResult),
    communities:
      communities === null
        ? emptyGroup(skipped)
        : toGroup(communities, paging(communities.total), toCommunityResult),
    posts:
      posts === null
        ? emptyGroup(skipped)
        : toGroup(posts, paging(posts.total), toPostResult),
    tags:
      tags === null
        ? emptyGroup(skipped)
        : toGroup(tags, paging(tags.total), toTagResult),
    totalResults: totals,
  };
}
