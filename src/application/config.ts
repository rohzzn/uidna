/**
 * Configuration: `uidna.config.json` in the working directory plus a few
 * environment variables, parsed with Zod. Everything is optional.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

export const ConfigSchema = z
  .object({
    /** Directory that holds scans. Default `.uidna`. */
    outRoot: z.string().min(1).optional(),
    /** Default viewport widths. */
    viewports: z.array(z.number().int().min(240).max(3840)).min(1).max(6).optional(),
    budget: z
      .object({
        timeMs: z.number().int().positive().nullable().optional(),
        pages: z.number().int().positive().nullable().optional(),
        actions: z.number().int().positive().nullable().optional(),
        resources: z.number().int().positive().nullable().optional(),
      })
      .optional(),
    /** Additional accessible-name words the explorer must never click. */
    denyNames: z.array(z.string().min(1)).optional(),
    headless: z.boolean().optional(),
    /** Default CDP endpoint for `doctor` and attach mode. */
    cdpEndpoint: z.string().optional(),
    debug: z.boolean().optional(),
  })
  .strict();
export type Config = z.infer<typeof ConfigSchema>;

const EnvSchema = z.object({
  UIDNA_OUT_ROOT: z.string().min(1).optional(),
  UIDNA_DEBUG: z.string().optional(),
  UIDNA_CDP_ENDPOINT: z.string().optional(),
  UIDNA_HEADLESS: z.string().optional(),
});

/** Name of the config file looked up in the working directory. */
export const CONFIG_FILE = 'uidna.config.json';

/** Load config from `cwd/uidna.config.json` (if present) and the environment. Environment wins. */
export async function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<Result<Config>> {
  let fromFile: Config = {};
  const path = join(cwd, CONFIG_FILE);
  try {
    const text = await readFile(path, 'utf8');
    const parsed = ConfigSchema.safeParse(JSON.parse(text));
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.map(String).join('.')}: ${i.message}`);
      return err(uidnaError('config', `${path} is invalid: ${issues.join('; ')}`, { details: { issues } }));
    }
    fromFile = parsed.data;
  } catch (cause) {
    const code = (cause as { code?: string }).code;
    if (code !== 'ENOENT') return err(toError(cause, 'config', `read ${path}`));
  }

  const envParsed = EnvSchema.safeParse(env);
  if (!envParsed.success) return err(uidnaError('config', 'invalid environment', { details: { issues: envParsed.error.issues } }));
  const e = envParsed.data;
  const merged: Config = { ...fromFile };
  if (e.UIDNA_OUT_ROOT) merged.outRoot = e.UIDNA_OUT_ROOT;
  if (e.UIDNA_DEBUG !== undefined) merged.debug = ['1', 'true', 'yes'].includes(e.UIDNA_DEBUG.toLowerCase());
  if (e.UIDNA_CDP_ENDPOINT) merged.cdpEndpoint = e.UIDNA_CDP_ENDPOINT;
  if (e.UIDNA_HEADLESS !== undefined) merged.headless = !['0', 'false', 'no'].includes(e.UIDNA_HEADLESS.toLowerCase());
  return ok(merged);
}
