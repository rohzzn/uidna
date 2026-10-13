/**
 * Registers the browser-driven workflows (scan, explore, generate, verify,
 * report, reconstruct) in the handler registry. Filled in as each workflow
 * lands; until then the registry only advertises the read-only tools.
 */
import type { AnyHandler } from './handlers.js';

/** Handlers for the browser-driven workflows. */
export function registerWorkflowHandlers(): [string, AnyHandler][] {
  return [];
}
