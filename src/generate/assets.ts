/**
 * Assets: authorized images with a stored local copy are copied into
 * `public/assets/`; everything else becomes a labeled placeholder that keeps
 * the measured box. Screenshots are never used as UI.
 */
import { basename, resolve, sep } from 'node:path';
import type { Asset, UiDnaDocument, UiNode } from '@rohzzn/uidna-schema';
import { compareStrings } from './jsx.js';
import type { GenerationModel } from './model.js';

/** A placeholder recorded in the generate record. */
export interface PlaceholderRecord {
  readonly kind: string;
  readonly assetId: string;
  readonly url: string;
  readonly reason: string;
  readonly file: string;
}

/** A copy to perform after rendering. */
export interface AssetCopy {
  readonly assetId: string;
  readonly from: string;
  /** Relative to outDir, forward slashes. */
  readonly to: string;
  /** URL used in the generated markup. */
  readonly src: string;
}

/** How a node that references an asset is rendered. */
export type AssetResolution =
  | { readonly kind: 'file'; readonly assetId: string; readonly src: string }
  | { readonly kind: 'placeholder'; readonly assetId: string; readonly url: string; readonly assetKind: string; readonly reason: string };

/** State shared between the registries of the pages of one document (copies and placeholders are per project). */
interface SharedAssetState {
  readonly copies: Map<string, AssetCopy>;
  readonly usedNames: Map<string, string>;
  readonly placeholders: PlaceholderRecord[];
}

/** Collects copies and placeholders while rendering. */
export class AssetRegistry {
  private readonly copies: Map<string, AssetCopy>;
  private readonly usedNames: Map<string, string>;
  readonly placeholders: PlaceholderRecord[];

  constructor(
    private readonly dna: UiDnaDocument,
    private readonly model: GenerationModel,
    private readonly scanDir: string,
    shared: SharedAssetState = { copies: new Map(), usedNames: new Map(), placeholders: [] },
  ) {
    this.copies = shared.copies;
    this.usedNames = shared.usedNames;
    this.placeholders = shared.placeholders;
  }

  /** A registry for another page's model that shares this one's copies and placeholders. */
  forModel(model: GenerationModel): AssetRegistry {
    return new AssetRegistry(this.dna, model, this.scanDir, { copies: this.copies, usedNames: this.usedNames, placeholders: this.placeholders });
  }

  /** The asset used by `node` in the narrowest base state, if any. */
  findAsset(node: UiNode): Asset | undefined {
    const stateId = this.model.narrowest.state.id;
    const src = node.attrs.src;
    const candidates = [...this.dna.assets].sort((a, b) => compareStrings(a.id, b.id));
    return (
      candidates.find((asset) => asset.usage.some((u) => u.stateId === stateId && u.nodeId === node.id)) ??
      candidates.find((asset) => asset.usage.some((u) => u.nodePath === node.path)) ??
      (src === undefined ? undefined : candidates.find((asset) => asset.url === src))
    );
  }

  /** Resolve an `<img>` node. */
  resolveImage(node: UiNode): AssetResolution {
    const asset = this.findAsset(node);
    if (asset === undefined) {
      return { kind: 'placeholder', assetId: `missing:${node.path}`, url: node.attrs.src ?? '', assetKind: 'image', reason: 'no asset record for this image in the document' };
    }
    if (asset.authorization !== 'authorized') {
      const reason = asset.authorization === 'unauthorized' ? 'asset is marked unauthorized' : 'asset authorization is unknown (authorize it with annotate_dna to copy it)';
      return { kind: 'placeholder', assetId: asset.id, url: asset.url, assetKind: asset.kind, reason };
    }
    if (asset.localPath === undefined) {
      return { kind: 'placeholder', assetId: asset.id, url: asset.url, assetKind: asset.kind, reason: 'asset is authorized but no local copy was stored during the scan' };
    }
    const from = resolve(this.scanDir, asset.localPath);
    const root = resolve(this.scanDir);
    if (from !== root && !from.startsWith(root + sep)) {
      return { kind: 'placeholder', assetId: asset.id, url: asset.url, assetKind: asset.kind, reason: 'stored copy path escapes the scan directory' };
    }
    const existing = this.copies.get(asset.id);
    if (existing) return { kind: 'file', assetId: asset.id, src: existing.src };
    const name = this.uniqueName(asset.id, basename(asset.localPath));
    const copy: AssetCopy = { assetId: asset.id, from, to: `public/assets/${name}`, src: `/assets/${name}` };
    this.copies.set(asset.id, copy);
    return { kind: 'file', assetId: asset.id, src: copy.src };
  }

  /** Resolve a node whose tag cannot be reproduced (inline svg, video, iframe, canvas…). */
  resolveUnreproducible(node: UiNode): AssetResolution {
    const tag = node.tag.toLowerCase();
    const asset = this.findAsset(node);
    const reason = tag === 'svg' ? 'inline svg markup is not captured in Phase 1' : `<${tag}> content is not captured in Phase 1`;
    return { kind: 'placeholder', assetId: asset?.id ?? `inline-${tag}:${node.path}`, url: asset?.url ?? node.attrs.src ?? 'inline', assetKind: asset?.kind ?? (tag === 'svg' ? 'svg' : tag), reason };
  }

  /** Record a placeholder that was rendered into `file`. */
  recordPlaceholder(resolution: Extract<AssetResolution, { kind: 'placeholder' }>, file: string): void {
    if (this.placeholders.some((p) => p.assetId === resolution.assetId && p.file === file)) return;
    this.placeholders.push({ kind: resolution.assetKind, assetId: resolution.assetId, url: resolution.url, reason: resolution.reason, file });
  }

  /** All copies to perform, sorted by destination. */
  copyList(): AssetCopy[] {
    return [...this.copies.values()].sort((a, b) => compareStrings(a.to, b.to));
  }

  private uniqueName(assetId: string, original: string): string {
    const safe = original.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '') || 'asset';
    const owner = this.usedNames.get(safe);
    if (owner === undefined || owner === assetId) {
      this.usedNames.set(safe, assetId);
      return safe;
    }
    const prefixed = `${assetId.replace(/[^A-Za-z0-9_-]+/g, '_')}-${safe}`;
    this.usedNames.set(prefixed, assetId);
    return prefixed;
  }
}

/** Assets of kind `other` with a JSON mime type: candidates for the Phase 1 `src/mocks/data.ts` mocks. */
export function jsonAssets(dna: UiDnaDocument): Asset[] {
  return dna.assets.filter((asset) => asset.kind === 'other' && /json/i.test(asset.mime ?? '')).sort((a, b) => compareStrings(a.id, b.id));
}

/** Captured JSON responses (`kind: 'data'`): each becomes a typed mock file under `src/mocks/`. */
export function dataAssets(dna: UiDnaDocument): Asset[] {
  return dna.assets.filter((asset) => asset.kind === 'data').sort((a, b) => compareStrings(a.id, b.id));
}
