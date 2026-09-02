import type { FieldValues, Path, UseFormSetError } from "react-hook-form";

import { ApiError } from "./errors";

/**
 * Moves a 422's field errors onto the form that produced them.
 *
 * The backend's validation middleware namespaces each field by where it was
 * found — `body.email`, `query.cursor`, `params.id` — because one request can
 * fail validation in more than one place. Forms only ever submit a body, so
 * the prefix is stripped to get back to the field name the form knows.
 */
const LOCATION_PREFIX = /^(body|query|params|headers)\./;

export function toFieldName(field: string): string {
  return field.replace(LOCATION_PREFIX, "");
}

/**
 * Returns `true` when at least one error was attached to a known field, so the
 * caller can skip a redundant toast — the message is already on-screen.
 */
export function applyApiFieldErrors<T extends FieldValues>(
  error: unknown,
  setError: UseFormSetError<T>,
  knownFields: readonly Path<T>[],
): boolean {
  if (!(error instanceof ApiError) || !error.isValidationError) return false;

  let applied = false;
  for (const detail of error.details) {
    const name = toFieldName(detail.field) as Path<T>;
    if (!knownFields.includes(name)) continue;
    setError(name, { type: "server", message: detail.message });
    applied = true;
  }

  return applied;
}
