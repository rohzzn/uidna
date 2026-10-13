/**
 * Public programmatic API of UI DNA. The CLI and the MCP server are thin
 * adapters over the same application layer exported here.
 */
export * from './domain/index.js';
export * from './contracts/index.js';
export type * from './browser/types.js';
export { createPlaywrightProvider } from './browser/index.js';
export { RENDERING_STYLE_PROPERTIES, STYLE_DEFAULTS } from './browser/style-properties.js';
export { ScanStore, DEFAULT_OUT_ROOT } from './application/scan-store.js';
export * from './application/records.js';
export { createContext, withOutRoot, type WorkflowContext, type ContextOptions } from './application/context.js';
export { EvidenceLedger } from './application/ledger.js';
export { loadConfig, ConfigSchema, type Config } from './application/config.js';
export { createHandlers, dispatch, bind, envelopeSchema, implementedTools, type HandlerMap, type Handler } from './application/handlers.js';
export { registerWorkflowHandlers } from './application/workflows.js';
export { inspectDna, inspectElement, searchComponents, extractTokens } from './application/inspect.js';
export { annotateDna } from './application/annotate.js';
export { exportEvidence } from './application/export.js';
export { serveStatic, type StaticServer } from './application/static-server.js';
export { createMcpServer, serveStdio } from './server/mcp.js';
