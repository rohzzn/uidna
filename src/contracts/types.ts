/**
 * Tool contract shape. Every MCP tool and CLI command is described once here;
 * the MCP adapter, the CLI and the generated catalog all read from it.
 */
import type { z } from 'zod';

/** The kind of question a tool answers. */
export type ToolShape = 'capture' | 'inspect' | 'search' | 'workflow' | 'mutate' | 'compare';

/** MCP tool annotations. Hints, not authorization. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

/** CLI mirror of a tool. */
export interface CliMirror {
  readonly command: string;
  readonly summary: string;
  /** Positional arguments in order, mapped to input fields. */
  readonly positionals: readonly string[];
}

/** A tool contract: name, documentation, schemas and effects. */
export interface ToolContract<I extends z.ZodObject = z.ZodObject, O extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly shape: ToolShape;
  readonly input: I;
  readonly output: O;
  readonly annotations: ToolAnnotations;
  readonly cli: CliMirror;
  /** True when the tool accepts progress tokens and cancellation. */
  readonly longRunning: boolean;
}

/** Infer the input type of a contract. */
export type ToolInput<C> = C extends ToolContract<infer I> ? z.infer<I> : never;

/** Infer the output type of a contract. */
export type ToolOutput<C> = C extends ToolContract<z.ZodObject, infer O> ? z.infer<O> : never;

/** Helper that preserves the generic parameters when declaring a contract. */
export function defineTool<I extends z.ZodObject, O extends z.ZodType>(contract: ToolContract<I, O>): ToolContract<I, O> {
  return contract;
}
