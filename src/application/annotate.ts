/**
 * `annotate_dna`: apply the host agent's readings to a document. Every patch
 * is stored with provenance `inferred` / `agent`; measured values are never
 * overwritten. The document is re-validated before it is written.
 */
import { inferred, validateUiDna, formatIssues, type AnnotationRecord, type BehaviorRule, type InferredProvenance, type UiDnaDocument } from '@uidna/schema';
import type { AnnotationPatch, annotateDna as annotateDnaContract } from '../contracts/tools.js';
import type { ToolInput, ToolOutput } from '../contracts/types.js';
import { isoNow } from '../domain/clock.js';
import { uidnaError } from '../domain/errors.js';
import { envelope, type Envelope } from '../domain/evidence.js';
import { err, ok, type Result } from '../domain/result.js';
import type { WorkflowContext } from './context.js';
import { withOutRoot } from './context.js';
import { loadScanAndDna } from './inspect.js';
import { locatePath, toPointer } from './json-path.js';

interface Applied {
  readonly op: string;
  readonly path: string;
}

function provenanceFor(patch: AnnotationPatch, capturedAt: string): InferredProvenance {
  const base = inferred(null, { capturedAt, ...(patch.rationale === undefined ? {} : { rationale: patch.rationale }), ...(patch.basedOn === undefined ? {} : { basedOn: patch.basedOn }) }, patch.confidence ?? 0.7);
  return base.provenance as InferredProvenance;
}

function isAttributed(value: unknown): value is { value: unknown; provenance: { kind: string }; annotation?: unknown } {
  return value !== null && typeof value === 'object' && 'provenance' in value && 'value' in value;
}

/** Apply one patch to a document in place. Returns the JSON pointer of the changed location. */
export function applyPatch(doc: UiDnaDocument, patch: AnnotationPatch, capturedAt: string): Result<Applied> {
  const provenance = provenanceFor(patch, capturedAt);
  switch (patch.op) {
    case 'name': {
      const list =
        patch.target === 'component'
          ? doc.components.definitions
          : patch.target === 'token'
            ? [
                ...doc.visual.tokens.colors,
                ...doc.visual.tokens.fontFamilies,
                ...doc.visual.tokens.fontSizes,
                ...doc.visual.tokens.spacing,
                ...doc.visual.tokens.radii,
                ...doc.visual.tokens.shadows,
                ...doc.visual.tokens.breakpoints,
              ]
            : doc.visual.tokens.typography;
      const target = list.find((item) => item.id === patch.id);
      if (!target) return err(uidnaError('not-found', `${patch.target} ${patch.id} not found`));
      target.name = { value: patch.value, provenance };
      return ok({ op: patch.op, path: `${patch.target}:${patch.id}/name` });
    }
    case 'annotate': {
      const location = locatePath(doc, patch.path);
      if (!location.ok) return location;
      const existing = location.value.value;
      if (!isAttributed(existing)) {
        return err(uidnaError('validation', `path "${patch.path}" is not an attributed value (expected an object with value and provenance)`));
      }
      if (existing.provenance.kind === 'inferred') {
        return err(uidnaError('validation', `path "${patch.path}" is already an agent-inferred value; annotate the measured value instead`));
      }
      if (existing.value !== null && typeof existing.value !== typeof patch.value) {
        return err(uidnaError('validation', `path "${patch.path}": annotation type ${typeof patch.value} does not match measured type ${typeof existing.value}`));
      }
      existing.annotation = { value: patch.value, provenance };
      return ok({ op: patch.op, path: toPointer(location.value.segments) + '/annotation' });
    }
    case 'authorize': {
      const asset = doc.assets.find((a) => a.id === patch.assetId);
      if (!asset) return err(uidnaError('not-found', `asset ${patch.assetId} not found`));
      // The asset's provenance describes how its url, bytes and usage were measured; the agent's
      // authorization decision lives in the annotation log and is never written over it.
      asset.authorization = patch.authorization;
      return ok({ op: patch.op, path: `asset:${patch.assetId}/authorization` });
    }
    case 'limitation': {
      doc.limitations.push(patch.limitation);
      return ok({ op: patch.op, path: `/limitations/${doc.limitations.length - 1}` });
    }
    case 'behavior': {
      const state = doc.states.items.find((s) => s.id === patch.event.stateId);
      if (!state) return err(uidnaError('not-found', `state ${patch.event.stateId} not found`));
      const node = state.nodes.find((n) => n.id === patch.event.nodeId);
      if (!node) return err(uidnaError('not-found', `node ${patch.event.nodeId} not found in ${state.id}`));
      if (patch.transitionId !== undefined && !doc.states.transitions.some((t) => t.id === patch.transitionId)) {
        return err(uidnaError('not-found', `transition ${patch.transitionId} not found`));
      }
      const effects: BehaviorRule['effects'] = patch.effects.map((e) => {
        const targetNode = e.targetNodeId === undefined ? undefined : state.nodes.find((n) => n.id === e.targetNodeId);
        return {
          kind: e.kind,
          ...(e.attribute === undefined ? {} : { attribute: e.attribute }),
          ...(e.from === undefined ? {} : { from: e.from }),
          ...(e.to === undefined ? {} : { to: e.to }),
          ...(e.targetNodeId === undefined ? {} : { targetNodeId: e.targetNodeId }),
          ...(targetNode === undefined ? {} : { targetNodePath: targetNode.path }),
          ...(e.details === undefined ? {} : { details: e.details }),
        };
      });
      const rule: BehaviorRule = {
        id: `bh_agent_${String(doc.behavior.filter((b) => b.id.startsWith('bh_agent_')).length + 1).padStart(2, '0')}`,
        event: {
          type: patch.event.type,
          target: { nodeId: node.id, nodePath: node.path, role: node.role, name: node.name, tag: node.tag, nth: node.a11y.nth ?? 0 },
          ...(patch.event.key === undefined ? {} : { key: patch.event.key }),
        },
        transitionId: patch.transitionId ?? null,
        effects,
        provenance: { ...provenance, stateId: state.id, viewport: state.viewport },
      };
      doc.behavior.push(rule);
      return ok({ op: patch.op, path: `/behavior/${doc.behavior.length - 1}` });
    }
  }
}

/** `annotate_dna`. Patches are applied in order; a patch that fails is rejected and the rest continue. */
export async function annotateDna(
  baseCtx: WorkflowContext,
  input: ToolInput<typeof annotateDnaContract>,
): Promise<Result<Envelope<ToolOutput<typeof annotateDnaContract>>>> {
  const ctx = withOutRoot(baseCtx, input.outRoot);
  const loaded = await loadScanAndDna(ctx, input.scanId);
  if (!loaded.ok) return loaded;
  const { dnaPath } = loaded.value;
  let doc = loaded.value.dna;
  const capturedAt = isoNow(ctx.clock);
  const applied: ToolOutput<typeof annotateDnaContract>['applied'] = [];
  const rejected: ToolOutput<typeof annotateDnaContract>['rejected'] = [];

  input.patches.forEach((patch, index) => {
    const candidate = structuredClone(doc);
    const result = applyPatch(candidate, patch, capturedAt);
    if (!result.ok) {
      rejected.push({ index, op: patch.op, reason: result.error.message });
      return;
    }
    const annotationId = `an_${String(candidate.annotations.length + 1).padStart(3, '0')}`;
    const record: AnnotationRecord = {
      id: annotationId,
      appliedAt: capturedAt,
      path: result.value.path,
      op: patch.op,
      value: 'value' in patch ? patch.value : patch.op === 'authorize' ? patch.authorization : patch.op === 'limitation' ? patch.limitation : { event: patch.event, effects: patch.effects },
      provenance: provenanceFor(patch, capturedAt),
    };
    candidate.annotations.push(record);
    const validation = validateUiDna(candidate);
    if (!validation.success) {
      rejected.push({ index, op: patch.op, reason: `document would become invalid: ${formatIssues(validation).slice(0, 3).join('; ')}` });
      return;
    }
    doc = validation.data;
    applied.push({ index, op: patch.op, path: result.value.path, annotationId });
  });

  if (applied.length > 0) {
    const saved = await ctx.store.saveDna(input.scanId, doc);
    if (!saved.ok) return saved;
  }

  const record = await ctx.ledger.record({
    kind: 'annotate',
    inputs: { scanId: input.scanId, patches: input.patches.length, ops: input.patches.map((p) => p.op) },
    artifacts: ['dna.json'],
    scanId: input.scanId,
  });
  return ok(
    envelope(
      record,
      { scanId: input.scanId, dnaPath, applied, rejected, annotations: doc.annotations.length },
      { limitations: rejected.length > 0 ? [`${rejected.length} of ${input.patches.length} patches were rejected; see rejected[].reason`] : [] },
    ),
  );
}
