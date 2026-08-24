import { describe, expect, it } from "vitest";

import { openApiDocument } from "../src/config/openapi.js";

/**
 * Contract checks on the OpenAPI document.
 *
 * The document is hand-written, so the failure mode is a `$ref` pointing at a
 * schema nobody added, or a path documented for a route that was never mounted.
 * Both are invisible until a client tries to generate against it — which is
 * exactly the sort of thing worth a test rather than a proofread.
 */

type Json = unknown;

function walk(node: Json, visit: (value: Record<string, Json>) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
    return;
  }
  if (typeof node === "object" && node !== null) {
    const record = node as Record<string, Json>;
    visit(record);
    for (const value of Object.values(record)) walk(value, visit);
  }
}

function collectRefs(document: Json): string[] {
  const refs: string[] = [];
  walk(document, (node) => {
    const ref = node["$ref"];
    if (typeof ref === "string") refs.push(ref);
  });
  return refs;
}

function resolve(document: Json, ref: string): Json | undefined {
  if (!ref.startsWith("#/")) return undefined;

  let current: Json = document;
  for (const segment of ref.slice(2).split("/")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, Json>)[segment];
    if (current === undefined) return undefined;
  }
  return current;
}

describe("OpenAPI document", () => {
  it("resolves every $ref it contains", () => {
    const refs = [...new Set(collectRefs(openApiDocument))];
    expect(refs.length).toBeGreaterThan(0);

    const unresolved = refs.filter((ref) => resolve(openApiDocument, ref) === undefined);
    expect(unresolved, `unresolved $refs: ${unresolved.join(", ")}`).toEqual([]);
  });

  it("declares the Phase 7 community paths", () => {
    const paths = openApiDocument.paths as Record<string, unknown>;

    for (const path of [
      "/communities",
      "/communities/{slug}",
      "/communities/{slug}/members",
      "/communities/{slug}/moderators",
      "/communities/{slug}/join",
      "/communities/{slug}/leave",
      "/communities/{slug}/members/{username}",
      "/communities/{slug}/transfer",
      "/communities/{slug}/rules",
      "/communities/{slug}/tags",
      "/communities/{slug}/events",
      "/communities/{slug}/events/{id}",
      "/communities/{slug}/pins",
      "/communities/{slug}/pins/{id}",
      "/communities/{slug}/posts",
    ]) {
      expect(paths, `missing path ${path}`).toHaveProperty([path]);
    }
  });

  it("declares the Phase 7 schemas", () => {
    const components = openApiDocument.components as Record<string, unknown>;
    const schemas = components["schemas"] as Record<string, unknown>;

    for (const name of [
      "Community",
      "CommunitySummary",
      "CommunityEvent",
      "CommunityEventDetail",
      "CommunityMemberWithUser",
      "CommunityViewerState",
      "CreateCommunityRequest",
      "UpdateCommunityRequest",
      "AddCommunityMemberRequest",
      "CommunityRoleRequest",
      "TransferOwnershipRequest",
      "ReplaceRulesRequest",
      "ReplaceTagsRequest",
      "CreateEventRequest",
      "UpdateEventRequest",
      "PinPostRequest",
    ]) {
      expect(schemas, `missing schema ${name}`).toHaveProperty([name]);
    }
  });

  it("marks every mutating community operation as requiring a bearer token", () => {
    const paths = openApiDocument.paths as Record<string, Record<string, Json>>;
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/communities")) continue;

      for (const [method, operation] of Object.entries(operations)) {
        if (!["post", "patch", "put", "delete"].includes(method)) continue;
        const security = (operation as Record<string, Json>)["security"];
        if (security === undefined) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(missing, `unauthenticated write operations: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("documents a 404 rather than a 403 on every community read", () => {
    // The house rule: a hidden community is indistinguishable from a missing
    // one, so the read operations must not advertise 403 at all.
    const paths = openApiDocument.paths as Record<string, Record<string, Json>>;
    const offenders: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/communities")) continue;
      const get = operations["get"] as Record<string, Json> | undefined;
      if (!get) continue;

      const responses = get["responses"] as Record<string, Json>;
      if ("403" in responses) offenders.push(`GET ${path}`);
    }

    expect(offenders, `reads advertising 403: ${offenders.join(", ")}`).toEqual([]);
  });
});
