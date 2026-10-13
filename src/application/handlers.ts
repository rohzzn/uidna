/**
 * The handler registry: tool name → workflow function. The MCP server and
 * the CLI both dispatch through it, after validating the input against the
 * tool's contract, so the two adapters cannot drift apart.
 */
import { z } from 'zod';
import { TOOL_CATALOG, findTool } from '../contracts/catalog.js';
import type { ToolContract, ToolInput, ToolOutput } from '../contracts/types.js';
import { uidnaError } from '../domain/errors.js';
import type { Envelope } from '../domain/evidence.js';
import { err, type Result } from '../domain/result.js';
import type { WorkflowContext } from './context.js';
import * as contracts from '../contracts/tools.js';
import { annotateDna } from './annotate.js';
import { exportEvidence } from './export.js';
import { extractTokens, inspectDna, inspectElement, searchComponents } from './inspect.js';

/** A typed workflow function for one contract. */
export type Handler<C extends ToolContract> = (ctx: WorkflowContext, input: ToolInput<C>) => Promise<Result<Envelope<ToolOutput<C>>>>;

/** An untyped handler as stored in the registry (input is validated before the call). */
export type AnyHandler = (ctx: WorkflowContext, input: unknown) => Promise<Result<Envelope<unknown>>>;

/** Registry of implemented tools. Tools without a handler are not advertised. */
export type HandlerMap = ReadonlyMap<string, AnyHandler>;

/** Wrap a typed handler so the registry validates its input first. */
export function bind<C extends ToolContract>(contract: C, handler: Handler<C>): [string, AnyHandler] {
  const wrapped: AnyHandler = async (ctx, input) => {
    const parsed = contract.input.safeParse(input ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.') || '<input>'}: ${i.message}`);
      return err(uidnaError('validation', `invalid input for ${contract.name}: ${issues.join('; ')}`, { details: { issues } }));
    }
    const typed = handler as unknown as AnyHandler;
    return typed(ctx, parsed.data);
  };
  return [contract.name, wrapped];
}

/** The handlers that exist today. Later steps register the browser-driven workflows. */
export function createHandlers(extra: Iterable<[string, AnyHandler]> = []): HandlerMap {
  const entries: [string, AnyHandler][] = [
    bind(contracts.inspectDna, inspectDna),
    bind(contracts.inspectElement, inspectElement),
    bind(contracts.searchComponents, searchComponents),
    bind(contracts.extractTokens, extractTokens),
    bind(contracts.annotateDna, annotateDna),
    bind(contracts.exportEvidence, exportEvidence),
    ...extra,
  ];
  const map = new Map<string, AnyHandler>();
  for (const [name, handler] of entries) {
    if (!findTool(name)) throw new Error(`handler for unknown tool ${name}`);
    map.set(name, handler);
  }
  return map;
}

/** Contracts in catalog order that have a handler. */
export function implementedTools(handlers: HandlerMap): ToolContract[] {
  return TOOL_CATALOG.filter((tool) => handlers.has(tool.name));
}

/** Zod schema of the evidence envelope around a tool's result. */
export function envelopeSchema<O extends z.ZodType>(output: O) {
  return z.object({
    result: output,
    evidence_id: z.string(),
    evidence: z.object({
      kind: z.string(),
      inputs: z.record(z.string(), z.unknown()),
      artifacts: z.array(z.string()),
      capturedAt: z.string(),
    }),
    limitations: z.array(z.string()),
    unknowns: z.array(z.string()),
  });
}

/** Dispatch a call by tool name. Unknown or unimplemented tools are a `not-found` error. */
export async function dispatch(handlers: HandlerMap, ctx: WorkflowContext, name: string, input: unknown): Promise<Result<Envelope<unknown>>> {
  const handler = handlers.get(name);
  if (!handler) {
    const known = findTool(name) ? 'is not implemented in this build' : 'is not a UI DNA tool';
    return err(uidnaError('not-found', `${name} ${known}`));
  }
  return handler(ctx, input);
}
