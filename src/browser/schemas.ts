/**
 * Zod schemas for captured data. Captures are validated when written to and
 * read from disk so a corrupt or hand-edited capture never reaches analysis.
 */
import { z } from 'zod';
import { RoleTreeNodeSchema, UiNodeSchema, ViewportSchema } from 'uidna-schema';
import type { CapturedAsset, CapturedFont, CapturedState, NetworkEntry, ScreenshotFile } from './types.js';

export const CapturedFontSchema: z.ZodType<CapturedFont> = z.object({
  family: z.string(),
  source: z.enum(['local', 'url', 'data']),
  url: z.string().optional(),
  weight: z.string().optional(),
  style: z.string().optional(),
  status: z.enum(['loaded', 'unloaded', 'error']),
});

export const CapturedAssetSchema: z.ZodType<CapturedAsset> = z.object({
  id: z.string(),
  kind: z.enum(['font', 'image', 'svg', 'video', 'icon', 'data', 'other']),
  url: z.string(),
  origin: z.enum(['same-origin', 'cross-origin', 'inline', 'data']),
  mime: z.string().optional(),
  bytes: z.number().int().min(0).optional(),
  digest: z.string().optional(),
  width: z.number().int().min(0).optional(),
  height: z.number().int().min(0).optional(),
  usedBy: z.array(z.string()),
  localPath: z.string().optional(),
  request: z.object({ method: z.string(), status: z.number().int().nullable(), mime: z.string().nullable() }).optional(),
});

export const NetworkEntrySchema: z.ZodType<NetworkEntry> = z.object({
  id: z.string(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().nullable(),
  resourceType: z.string(),
  mime: z.string().optional(),
  bytes: z.number().int().min(0).optional(),
  startedAt: z.string(),
  durationMs: z.number().min(0).optional(),
  fromCache: z.boolean().optional(),
  failure: z.string().optional(),
});

export const ScreenshotFileSchema: z.ZodType<ScreenshotFile> = z.object({
  path: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  digest: z.string(),
  truncated: z.boolean(),
});

export const CapturedStateSchema: z.ZodType<CapturedState> = z.object({
  url: z.string(),
  title: z.string(),
  viewport: ViewportSchema,
  capturedAt: z.string(),
  document: z.object({ width: z.number().int().min(0), height: z.number().int().min(0), scrollHeight: z.number().int().min(0) }),
  nodes: z.array(UiNodeSchema),
  styles: z.record(z.string(), z.record(z.string(), z.string())),
  roleTree: z.array(RoleTreeNodeSchema),
  roleTreeDigest: z.string(),
  domDigest: z.string(),
  screenshot: ScreenshotFileSchema.nullable(),
  fonts: z.array(CapturedFontSchema),
  assets: z.array(CapturedAssetSchema),
  network: z.array(NetworkEntrySchema),
  limitations: z.array(z.string()),
});
