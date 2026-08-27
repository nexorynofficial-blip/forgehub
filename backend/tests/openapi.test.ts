import { describe, expect, it } from "vitest";

import { SOCKET_EVENTS, openApiDocument } from "../src/config/openapi.js";

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

  /* ── Messaging (Phase 8) ───────────────────────────────────────────────── */

  it("declares the Phase 8 messaging paths", () => {
    const paths = openApiDocument.paths as Record<string, unknown>;

    for (const path of [
      "/messages/conversations",
      "/messages/conversations/{conversationId}",
      "/messages/conversations/{conversationId}/messages",
      "/messages/conversations/{conversationId}/messages/search",
      "/messages/conversations/{conversationId}/read",
      "/messages/conversations/{conversationId}/unread",
      "/messages/{messageId}",
      "/messages/{messageId}/reactions",
      "/messages/{messageId}/reactions/{emoji}",
    ]) {
      expect(paths, `missing path ${path}`).toHaveProperty([path]);
    }
  });

  it("declares the Phase 8 schemas", () => {
    const components = openApiDocument.components as Record<string, unknown>;
    const schemas = components["schemas"] as Record<string, unknown>;

    for (const name of [
      "Conversation",
      "Message",
      "MessageAttachment",
      "MessageReaction",
      "ReadReceipt",
      "CreateConversationRequest",
      "SendMessageRequest",
      "EditMessageRequest",
      "MarkReadRequest",
      "AddReactionRequest",
    ]) {
      expect(schemas, `missing schema ${name}`).toHaveProperty([name]);
    }
  });

  it("requires a bearer token on every messaging operation", () => {
    // Unlike projects, posts, and communities, messaging has no public face:
    // there is no anonymous reader of private correspondence, so *reads* are
    // checked here too rather than only writes.
    const paths = openApiDocument.paths as Record<string, Record<string, Json>>;
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/messages")) continue;

      for (const [method, operation] of Object.entries(operations)) {
        if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
        const security = (operation as Record<string, Json>)["security"];
        if (security === undefined) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(
      missing,
      `unauthenticated messaging operations: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("documents a 404 rather than a 403 on every messaging read", () => {
    // A conversation the caller does not belong to is indistinguishable from
    // one that does not exist, and so is one hidden by a block.
    const paths = openApiDocument.paths as Record<string, Record<string, Json>>;
    const offenders: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/messages")) continue;
      const get = operations["get"] as Record<string, Json> | undefined;
      if (!get) continue;

      const responses = get["responses"] as Record<string, Json>;
      if ("403" in responses) offenders.push(`GET ${path}`);
    }

    expect(offenders, `messaging reads advertising 403: ${offenders.join(", ")}`).toEqual(
      [],
    );
  });

  it("documents every socket event the server actually registers", () => {
    // The realtime contract cannot be expressed as OpenAPI paths, so it lives
    // in `SOCKET_EVENTS` — and a documented-but-unimplemented event is the
    // same kind of silent lie as an unresolved $ref.
    const documented = new Set(SOCKET_EVENTS.map((entry) => entry.event));

    for (const event of [
      "message:send",
      "message:new",
      "message:read",
      "message:typing",
      "message:stop_typing",
      "user:online",
      "user:offline",
      "presence:update",
    ]) {
      expect(documented, `undocumented socket event ${event}`).toContain(event);
    }
  });

  /* ── Notifications (Phase 9) ───────────────────────────────────────────── */

  it("declares the Phase 9 notification paths", () => {
    const paths = openApiDocument.paths as Record<string, unknown>;

    for (const path of [
      "/notifications",
      "/notifications/unread",
      "/notifications/read-all",
      "/notifications/{id}/read",
    ]) {
      expect(paths, `missing path ${path}`).toHaveProperty([path]);
    }
  });

  it("declares the Phase 9 schemas", () => {
    const components = openApiDocument.components as Record<string, unknown>;
    const schemas = components["schemas"] as Record<string, unknown>;

    for (const name of ["Notification", "NotificationActor"]) {
      expect(schemas, `missing schema ${name}`).toHaveProperty([name]);
    }
  });

  it("requires a bearer token on every notification operation", () => {
    // Like messaging and unlike projects, posts, or communities, a
    // notification list has no public face — so reads are checked here too,
    // not only writes.
    const paths = openApiDocument.paths as Record<string, Record<string, Json>>;
    const missing: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/notifications")) continue;

      for (const [method, operation] of Object.entries(operations)) {
        if (!["get", "post", "patch", "put", "delete"].includes(method)) continue;
        const security = (operation as Record<string, Json>)["security"];
        if (security === undefined) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(
      missing,
      `unauthenticated notification operations: ${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("documents a 404 rather than a 403 on every notification read", () => {
    // A notification belonging to someone else and one that never existed must
    // stay indistinguishable, or the endpoint becomes an id oracle.
    const paths = openApiDocument.paths as Record<string, Record<string, Json>>;
    const offenders: string[] = [];

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/notifications")) continue;

      for (const [method, operation] of Object.entries(operations)) {
        if (!["get", "post"].includes(method)) continue;
        const responses = (operation as Record<string, Json>)["responses"] as Record<
          string,
          Json
        >;
        if ("403" in responses) offenders.push(`${method.toUpperCase()} ${path}`);
      }
    }

    expect(
      offenders,
      `notification routes advertising 403: ${offenders.join(", ")}`,
    ).toEqual([]);
  });

  it("declares no way for a client to create or delete a notification", () => {
    // Notifications are server-generated. A create endpoint would be a way to
    // write arbitrary text into another user's panel.
    const paths = openApiDocument.paths as Record<string, Record<string, Json>>;

    expect(Object.keys(paths["/notifications"] ?? {})).toEqual(["get"]);

    for (const [path, operations] of Object.entries(paths)) {
      if (!path.startsWith("/notifications")) continue;
      expect(Object.keys(operations), `${path} declares a delete`).not.toContain(
        "delete",
      );
    }
  });

  it("documents the notification:new socket event", () => {
    const documented = new Set(SOCKET_EVENTS.map((entry) => entry.event));
    expect(documented).toContain("notification:new");
  });
});
