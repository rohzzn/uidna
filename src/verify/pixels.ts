/**
 * Pixel comparison of two PNG screenshots: pixelmatch on the overlapping
 * region, SSIM (ssim.js) on the same region, and a diff image. Images of
 * different sizes are compared on their overlap and the mismatch is reported,
 * never hidden.
 */
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { ssim } from 'ssim.js';
import type { PixelComparison } from '../contracts/diff-report.js';
import { toError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

/** Width and height of an image in pixels. */
export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** Options for `comparePixels`. */
export interface PixelDiffOptions {
  /** pixelmatch color threshold (0..1, default 0.1). */
  readonly threshold?: number;
  /** Count anti-aliased pixels as differences (default false). */
  readonly includeAA?: boolean;
  /** Produce the diff image (default true). */
  readonly diffImage?: boolean;
}

/** Result of a pixel comparison. */
export interface PixelDiff {
  readonly original: ImageSize;
  readonly generated: ImageSize;
  /** Overlap width (the smaller of the two widths). */
  readonly width: number;
  /** Overlap height (the smaller of the two heights). */
  readonly height: number;
  readonly comparedPixels: number;
  readonly diffPixels: number;
  /** `diffPixels / comparedPixels`, or null when nothing could be compared. */
  readonly diffRatio: number | null;
  /** Mean structural similarity on the overlap in [0, 1], or null (see `ssimReason`). */
  readonly ssim: number | null;
  readonly ssimReason: string | null;
  readonly sizeMismatch: boolean;
  /** PNG bytes of the diff image over the overlap, or null when nothing was compared or it was not requested. */
  readonly diffImage: Buffer | null;
}

/** Decode a PNG buffer. */
export function decodePng(bytes: Uint8Array): Result<PNG> {
  try {
    return ok(PNG.sync.read(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  } catch (cause) {
    return err(toError(cause, 'verify', 'decode PNG'));
  }
}

/** Encode a PNG. */
export function encodePng(png: PNG): Result<Buffer> {
  try {
    return ok(PNG.sync.write(png));
  } catch (cause) {
    return err(toError(cause, 'verify', 'encode PNG'));
  }
}

/** Copy the top-left `width`×`height` region of a decoded PNG into a tightly packed RGBA buffer. */
function cropRgba(png: PNG, width: number, height: number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  const rowBytes = width * 4;
  const sourceRowBytes = png.width * 4;
  for (let y = 0; y < height; y += 1) {
    const start = y * sourceRowBytes;
    out.set(png.data.subarray(start, start + rowBytes), y * rowBytes);
  }
  return out;
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Compare two PNG images. Both are decoded; the overlap (min width × min
 * height) is compared with pixelmatch and ssim.js. Fails only when a PNG
 * cannot be decoded; an empty overlap yields null ratios and no diff image.
 */
export function comparePixels(originalPng: Uint8Array, generatedPng: Uint8Array, options: PixelDiffOptions = {}): Result<PixelDiff> {
  const original = decodePng(originalPng);
  if (!original.ok) return err(toError(original.error, 'verify', 'original screenshot'));
  const generated = decodePng(generatedPng);
  if (!generated.ok) return err(toError(generated.error, 'verify', 'generated screenshot'));
  const a = original.value;
  const b = generated.value;
  const width = Math.min(a.width, b.width);
  const height = Math.min(a.height, b.height);
  const sizeMismatch = a.width !== b.width || a.height !== b.height;
  const sizes = { original: { width: a.width, height: a.height }, generated: { width: b.width, height: b.height } };
  if (width <= 0 || height <= 0) {
    return ok({
      ...sizes,
      width: Math.max(0, width),
      height: Math.max(0, height),
      comparedPixels: 0,
      diffPixels: 0,
      diffRatio: null,
      ssim: null,
      ssimReason: 'the screenshots have no overlapping region',
      sizeMismatch,
      diffImage: null,
    });
  }
  const left = sizeMismatch ? cropRgba(a, width, height) : new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
  const right = sizeMismatch ? cropRgba(b, width, height) : new Uint8Array(b.data.buffer, b.data.byteOffset, b.data.byteLength);
  const wantDiff = options.diffImage ?? true;
  const output = wantDiff ? new Uint8Array(width * height * 4) : null;
  let diffPixels: number;
  try {
    diffPixels = pixelmatch(left, right, output, width, height, {
      threshold: options.threshold ?? 0.1,
      includeAA: options.includeAA ?? false,
    });
  } catch (cause) {
    return err(toError(cause, 'verify', 'pixelmatch'));
  }
  const comparedPixels = width * height;

  let similarity: number | null = null;
  let ssimReason: string | null = null;
  try {
    const result = ssim(
      { data: new Uint8ClampedArray(left.buffer, left.byteOffset, left.byteLength), width, height },
      { data: new Uint8ClampedArray(right.buffer, right.byteOffset, right.byteLength), width, height },
    );
    similarity = Number.isFinite(result.mssim) ? Math.round(clampUnit(result.mssim) * 1_000_000) / 1_000_000 : null;
    if (similarity === null) ssimReason = 'ssim.js returned a non-finite value';
  } catch (cause) {
    similarity = null;
    ssimReason = `ssim.js failed: ${toError(cause, 'verify').message}`;
  }

  let diffImage: Buffer | null = null;
  if (output !== null) {
    const png = new PNG({ width, height });
    png.data = Buffer.from(output.buffer, output.byteOffset, output.byteLength);
    const encoded = encodePng(png);
    if (!encoded.ok) return encoded;
    diffImage = encoded.value;
  }

  return ok({
    ...sizes,
    width,
    height,
    comparedPixels,
    diffPixels,
    diffRatio: comparedPixels === 0 ? null : diffPixels / comparedPixels,
    ssim: similarity,
    ssimReason,
    sizeMismatch,
    diffImage,
  });
}

/** Convert a `PixelDiff` into the report's `PixelComparison` shape. */
export function toPixelComparison(diff: PixelDiff, diffImagePath: string | null): PixelComparison {
  return {
    width: diff.width,
    height: diff.height,
    comparedPixels: diff.comparedPixels,
    diffPixels: diff.diffPixels,
    diffRatio: diff.diffRatio === null ? null : Math.min(1, Math.max(0, diff.diffRatio)),
    ssim: diff.ssim,
    sizeMismatch: diff.sizeMismatch,
    diffImagePath,
  };
}
