import type { Router } from "express";
import { describe, expect, it } from "vitest";

import { openApiDocument } from "../src/config/openapi.js";
import { createAdminRouter } from "../src/modules/admin/admin.routes.js";
import { createAuthRouter } from "../src/modules/auth/auth.routes.js";
import { createCommunityRouter } from "../src/modules/communities/communities.routes.js";
import { createMessageRouter } from "../src/modules/messages/messages.routes.js";
import { createModerationRouter } from "../src/modules/moderation/moderation.routes.js";
import { createNotificationRouter } from "../src/modules/notifications/notifications.routes.js";
import {
  createCommentRouter,
  createFeedRouter,
  createPostRouter,
} from "../src/modules/posts/posts.routes.js";
import { createProjectRouter } from "../src/modules/projects/projects.routes.js";
import { createSearchRouter } from "../src/modules/search/search.routes.js";
import { createUserRouter } from "../src/modules/users/users.routes.js";

/**
 * Phase 13 — the route/contract reconciliation (TRD §32 "API endpoints",
 * ARCHITECTURE §35 "API integration tests").
 *
 * `openapi.test.ts` audits the OpenAPI *document*: that its schemas are
 * well-formed, that projections leak nothing, that no future-phase path is
 * declared. What nothing checked until now is the document against the
 * **router that actually exists** — so a route could be mounted and
 * undocumented, or documented and never mounted, and every existing test
 * would still pass.
 *
 * Both directions matter and they fail differently:
 *
 *   - **Mounted but undocumented** is the dangerous one. It is how a route
 *     gets exposed without ever appearing in a contract review — the
 *     "accidentally exposed route" case.
 *   - **Documented but not mounted** publishes a promise the server does not
 *     keep, which a generated client turns into a 404 at runtime.
 *
 * The reconciliation walks each module router with its known mount prefix
 * from `routes/index.ts`. It reads `layer.route.path`, which is stable public
 * shape; it deliberately does **not** parse Express's internal path-matching
 * regexes, which changed between Express 4 and 5 and would make this test a
 * liability rather than a guard.
 */

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> };
  handle?: { stack?: RouteLayer[] };
}

/** Mirrors `createV1Router()` exactly. */
const MOUNTS: ReadonlyArray<readonly [string, () => Router]> = [
  ["/auth", createAuthRouter],
  ["/users", createUserRouter],
  ["/projects", createProjectRouter],
  ["/posts", createPostRouter],
  ["/comments", createCommentRouter],
  ["/feed", createFeedRouter],
  ["/communities", createCommunityRouter],
  ["/messages", createMessageRouter],
  ["/notifications", createNotificationRouter],
  ["/search", createSearchRouter],
  ["/moderation", createModerationRouter],
  ["/admin", createAdminRouter],
];

/**
 * The version discovery route, declared inline on the v1 router rather than
 * in a module. Listed explicitly because it has no module router to walk.
 */
const INLINE_ROUTES: readonly string[] = ["GET /"];

const HTTP_METHODS = ["get", "post", "patch", "put", "delete"] as const;

function walk(stack: RouteLayer[], prefix: string, out: string[]): void {
  for (const layer of stack) {
    if (layer.route) {
      const path = prefix + layer.route.path;
      for (const [method, enabled] of Object.entries(layer.route.methods)) {
        if (enabled) out.push(`${method.toUpperCase()} ${path}`);
      }
      continue;
    }
    const nested = layer.handle?.stack;
    if (nested) walk(nested, prefix, out);
  }
}

/** `/users/:username` -> `/users/{username}`, minus any trailing slash. */
function toOpenApiOperation(operation: string): string {
  const [method = "", path = ""] = operation.split(" ");
  const converted = path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
  const trimmed =
    converted.length > 1 && converted.endsWith("/") ? converted.slice(0, -1) : converted;
  return `${method} ${trimmed}`;
}

function mountedOperations(): Set<string> {
  const raw: string[] = [...INLINE_ROUTES];
  for (const [prefix, createRouter] of MOUNTS) {
    const router = createRouter() as unknown as { stack: RouteLayer[] };
    walk(router.stack, prefix, raw);
  }
  return new Set(raw.map(toOpenApiOperation));
}

function documentedOperations(): Set<string> {
  const operations = new Set<string>();
  const paths = openApiDocument.paths as Record<string, Record<string, unknown>>;

  for (const [path, item] of Object.entries(paths)) {
    for (const method of Object.keys(item)) {
      if ((HTTP_METHODS as readonly string[]).includes(method)) {
        operations.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  return operations;
}

describe("OpenAPI ↔ router reconciliation", () => {
  const mounted = mountedOperations();
  const documented = documentedOperations();

  it("documents every route the application actually mounts", () => {
    const undocumented = [...mounted].filter((op) => !documented.has(op)).sort();

    // A mounted-but-undocumented route is a surface nobody reviewed.
    expect(undocumented).toEqual([]);
  });

  it("mounts every route the contract advertises", () => {
    const unmounted = [...documented].filter((op) => !mounted.has(op)).sort();

    // A documented-but-unmounted route is a 404 in every generated client.
    expect(unmounted).toEqual([]);
  });

  it("covers the whole API, not a coincidental subset", () => {
    // Guards the guard: if the walk silently returned nothing, both set
    // comparisons above would pass vacuously.
    expect(mounted.size).toBeGreaterThan(100);
    expect(documented.size).toBe(mounted.size);
  });

  it("declares no path outside the roots ARCHITECTURE §29 names", () => {
    const roots = new Set([
      "auth",
      "users",
      "profiles",
      "projects",
      "posts",
      "comments",
      "communities",
      "messages",
      "notifications",
      "search",
      "achievements",
      "moderation",
      "admin",
      "uploads",
      "feed",
    ]);

    for (const operation of documented) {
      const path = operation.split(" ")[1] ?? "";
      if (path === "/") continue;
      const root = path.split("/")[1] ?? "";
      expect(roots, `unexpected API root in ${operation}`).toContain(root);
    }
  });

  it("exposes no route for a phase that has not shipped", () => {
    // Phase 12 built the AI abstraction as a seam with no HTTP surface, and
    // achievements/uploads remain unbuilt. Asserted against the *router* here,
    // where `openapi.test.ts` asserts it against the document — a route could
    // otherwise exist while the document stayed silent.
    for (const prefix of ["/ai", "/achievements", "/uploads"]) {
      const leaked = [...mounted].filter((op) => op.includes(` ${prefix}`));
      expect(leaked).toEqual([]);
    }
  });

  it("requires every mutating operation to declare authentication", () => {
    /**
     * The two deliberate exceptions, enumerated rather than pattern-matched
     * so that adding a third is a decision someone makes here on purpose:
     *
     *   - `/auth/*` — you cannot present a bearer token before you have one.
     *   - `POST /projects/{slug}/view` — `optionalAuth` by design, because
     *     *"anonymous visitors are most of a public project's audience"*
     *     (`projects.routes.ts`). It increments a counter and returns nothing
     *     about the viewer.
     */
    const ANONYMOUS_BY_DESIGN = new Set(["POST /projects/{slug}/view"]);

    const paths = openApiDocument.paths as Record<
      string,
      Record<string, { security?: unknown[] }>
    >;
    const unsecured: string[] = [];

    for (const [path, item] of Object.entries(paths)) {
      if (path.startsWith("/auth/")) continue;

      for (const method of ["post", "patch", "put", "delete"] as const) {
        const operation = item[method];
        if (!operation) continue;

        const name = `${method.toUpperCase()} ${path}`;
        if (ANONYMOUS_BY_DESIGN.has(name)) continue;

        if (!Array.isArray(operation.security) || operation.security.length === 0) {
          unsecured.push(name);
        }
      }
    }

    expect(unsecured).toEqual([]);
  });

  it("keeps the anonymous-mutation exception list honest", () => {
    // If one of those routes ever gains a security requirement, the exception
    // above is stale and should be deleted rather than quietly carried.
    const paths = openApiDocument.paths as Record<
      string,
      Record<string, { security?: unknown[] }>
    >;

    const view = paths["/projects/{slug}/view"]?.["post"];
    expect(view).toBeDefined();
    expect(view?.security ?? []).toEqual([]);
  });
});
