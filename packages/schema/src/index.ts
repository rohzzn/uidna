/**
 * @uidna/schema — the UI DNA document schema.
 *
 * A UI DNA document describes a user interface down to the token, the
 * component and the state transition, with provenance on every value.
 */
import type { z } from 'zod';
import { UiDnaDocumentSchema, UI_DNA_VERSION } from './schema.js';
import type { UiDnaDocument } from './schema.js';

export * from './provenance.js';
export * from './schema.js';

/** Result of `validateUiDna`: either a validated document or the Zod error. */
export type UiDnaValidation = z.ZodSafeParseResult<UiDnaDocument>;

/** Validate an unknown value as a UI DNA document. Never throws. */
export function validateUiDna(input: unknown): UiDnaValidation {
  return UiDnaDocumentSchema.safeParse(input);
}

/** Parse an unknown value as a UI DNA document, throwing a `ZodError` on failure. */
export function parseUiDna(input: unknown): UiDnaDocument {
  return UiDnaDocumentSchema.parse(input);
}

/** Type guard: true when `input` is a valid UI DNA document. */
export function isUiDna(input: unknown): input is UiDnaDocument {
  return UiDnaDocumentSchema.safeParse(input).success;
}

/** Human-readable list of validation issues, one per line. */
export function formatIssues(validation: UiDnaValidation): string[] {
  if (validation.success) return [];
  return validation.error.issues.map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`);
}

/** True when a document's `dnaVersion` is one this package can read (same major version). */
export function isCompatibleVersion(dnaVersion: string): boolean {
  const [docMajor] = dnaVersion.split('.');
  const [ourMajor] = UI_DNA_VERSION.split('.');
  return docMajor !== undefined && docMajor === ourMajor;
}
