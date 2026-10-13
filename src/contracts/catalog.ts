/**
 * The canonical tool catalog. The MCP server registers these in order, the
 * CLI mirrors them, and `docs/tools.md` is generated from them.
 */
import type { ToolContract } from './types.js';
import {
  annotateDna,
  exploreInteractions,
  exportEvidence,
  extractTokens,
  generateProject,
  inspectDna,
  inspectElement,
  reconstructInterface,
  reportReconstruction,
  scanInterface,
  searchComponents,
  verifyReconstruction,
} from './tools.js';

/** All tools, in canonical order. */
export const TOOL_CATALOG: readonly ToolContract[] = [
  scanInterface,
  exploreInteractions,
  inspectDna,
  inspectElement,
  searchComponents,
  extractTokens,
  annotateDna,
  generateProject,
  verifyReconstruction,
  reportReconstruction,
  exportEvidence,
  reconstructInterface,
];

/** Look up a contract by tool name. */
export function findTool(name: string): ToolContract | undefined {
  return TOOL_CATALOG.find((tool) => tool.name === name);
}

/** CLI-only commands that are not MCP tools. */
export const CLI_ONLY_COMMANDS = [
  { command: 'setup', summary: 'Register the MCP server in Claude Code, Codex and Cursor (prints the plan, asks, backs up)' },
  { command: 'doctor', summary: 'Report browser availability, CDP reachability and registration state' },
  { command: 'serve', summary: 'Start the MCP server on stdio (what the registered command runs)' },
] as const;
