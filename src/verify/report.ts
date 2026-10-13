/**
 * The static HTML report: one self-contained file with inline CSS and no
 * JavaScript (overlay toggles are CSS-only checkboxes). Screenshots are
 * referenced by paths relative to the report file. Every page-derived string
 * is escaped before it reaches the markup.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import type { Attributed, Token, TypographyStyle, UiDnaDocument, UiState } from '@uidna/schema';
import type { WorkflowContext } from '../application/context.js';
import type { ScanRecord } from '../application/records.js';
import { pngSize } from '../browser/capture.js';
import { BoxMatchSchema, type DiffReport, type Finding, type VisualComparison } from '../contracts/diff-report.js';
import { toError } from '../domain/errors.js';
import { err, ok, tryCatch, type Result } from '../domain/result.js';
import { severityRank } from './findings.js';
import { attr, escapeHtml, formatNumber, formatPercent, safeCssColor } from './html.js';

/** Input of `renderReport`. */
export interface RenderReportInput {
  readonly ctx: WorkflowContext;
  readonly scan: ScanRecord;
  readonly dna: UiDnaDocument;
  /** Every verification attempt, in any order. */
  readonly attempts: readonly DiffReport[];
  /** Where to write the HTML (absolute, or relative to the context's working directory). */
  readonly outPath: string;
}

/** What `renderReport` wrote. */
export interface RenderedReport {
  readonly path: string;
  readonly attempts: number;
  /** Findings of the latest attempt (0 when there is none). */
  readonly findings: number;
  /** Base states rendered. */
  readonly states: number;
}

type BoxMatch = z.infer<typeof BoxMatchSchema>;
const BoxMatchesSchema = z.array(BoxMatchSchema);

/** Resolves scan-relative artifact paths to paths relative to the report, checking that the files exist. */
class ArtifactPaths {
  constructor(
    private readonly ctx: WorkflowContext,
    private readonly scanId: string,
    private readonly reportDir: string,
  ) {}

  absolute(scanRelative: string): string | null {
    const resolved = tryCatch(
      () => this.ctx.store.resolvePath(this.scanId, scanRelative),
      (cause) => toError(cause, 'validation'),
    );
    return resolved.ok ? resolved.value : null;
  }

  /** Path relative to the report (forward slashes), or null when the file does not exist or escapes the scan directory. */
  async relative(scanRelative: string | null): Promise<string | null> {
    if (scanRelative === null || scanRelative.length === 0) return null;
    const abs = this.absolute(scanRelative);
    if (abs === null) return null;
    try {
      if (!(await stat(abs)).isFile()) return null;
    } catch {
      return null;
    }
    const rel = relative(this.reportDir, abs);
    // On Windows a scan on another drive has no relative path; a file URL is the only reference a browser can open.
    if (isAbsolute(rel)) return pathToFileURL(abs).href;
    return rel.split(sep).join('/');
  }

  /** Width and height of a PNG artifact, or null. */
  async size(scanRelative: string | null): Promise<{ width: number; height: number } | null> {
    if (scanRelative === null) return null;
    const abs = this.absolute(scanRelative);
    if (abs === null) return null;
    try {
      return pngSize(await readFile(abs));
    } catch {
      return null;
    }
  }

  async boxes(attempt: number, stateId: string): Promise<BoxMatch[] | null> {
    const read = await this.ctx.store.readJson(this.scanId, `verify/attempt-${attempt}/${stateId}.boxes.json`, BoxMatchesSchema);
    return read.ok ? read.value : null;
  }
}

/* --------------------------------------------------------------- markup */

const esc = escapeHtml;

/** Code-point string order: locale independent, so the report is byte-identical on every machine. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '<td class="muted">—</td>';
  return `<td>${esc(String(value))}</td>`;
}

function table(headers: readonly string[], rows: readonly string[][], className = ''): string {
  if (rows.length === 0) return '<p class="muted">None.</p>';
  const head = headers.map((h) => `<th>${esc(h)}</th>`).join('');
  const body = rows.map((row) => `<tr>${row.join('')}</tr>`).join('\n');
  return `<table${className ? attr('class', className) : ''}><thead><tr>${head}</tr></thead><tbody>\n${body}\n</tbody></table>`;
}

function provenanceKind(value: Attributed<unknown> | undefined): string {
  return value === undefined ? '—' : value.provenance.kind;
}

function attributedText(value: Attributed<string> | undefined): string {
  if (value === undefined) return '—';
  return value.value ?? `unknown (${value.provenance.kind === 'unknown' ? value.provenance.reason : 'no value'})`;
}

function findingsTable(findings: readonly Finding[], withTransition = false): string {
  const sorted = [...findings].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || compareStrings(a.id, b.id));
  const headers = ['id', 'category', 'severity', 'property', 'original', 'generated', 'delta', withTransition ? 'transition' : 'node path', 'component', 'token', 'message'];
  const rows = sorted.map((f) => [
    cell(f.id),
    `<td><span${attr('class', `tag tag-${f.category}`)}>${esc(f.category)}</span></td>`,
    `<td><span${attr('class', `sev sev-${f.severity}`)}>${esc(f.severity)}</span></td>`,
    cell(f.property),
    cell(f.original),
    cell(f.generated),
    cell(f.delta === null ? null : formatNumber(f.delta, 3)),
    withTransition ? cell(f.transitionId) : cell(f.nodePath === null ? null : f.nodePath === '' ? '(body)' : f.nodePath),
    cell(f.componentId),
    cell(f.tokenId),
    `<td class="msg">${esc(f.message)}</td>`,
  ]);
  return table(headers, rows, 'findings');
}

function image(src: string | null, alt: string, caption: string): string {
  const body = src === null ? '<p class="muted">no image on disk</p>' : `<img${attr('src', src)}${attr('alt', alt)} loading="lazy">`;
  return `<figure><figcaption>${esc(caption)}</figcaption>${body}</figure>`;
}

function overlay(boxes: readonly BoxMatch[], size: { width: number; height: number } | null, side: 'original' | 'generated'): string {
  if (size === null || size.width <= 0 || size.height <= 0) return '';
  const pct = (n: number, total: number): string => formatNumber((n / total) * 100, 3);
  const items = boxes
    .map((b) => {
      const box = side === 'original' ? b.original : b.generated;
      if (box === null) return '';
      const style = `left:${pct(box.x, size.width)}%;top:${pct(box.y, size.height)}%;width:${pct(box.width, size.width)}%;height:${pct(box.height, size.height)}%`;
      return `<div${attr('class', `box box-${side}${b.generated === null ? ' box-unmatched' : ''}`)}${attr('style', style)}${attr('title', `${b.nodeId}: ${box.x},${box.y} ${box.width}×${box.height}`)}></div>`;
    })
    .join('');
  return `<div class="overlay">${items}</div>`;
}

function framed(src: string | null, alt: string, caption: string, size: { width: number; height: number } | null, overlays: string): string {
  if (src === null) return image(null, alt, caption);
  const ratio = size === null ? '' : attr('style', `aspect-ratio: ${size.width} / ${size.height}`);
  return `<figure><figcaption>${esc(caption)}</figcaption><div class="frame"${ratio}><img${attr('src', src)}${attr('alt', alt)} loading="lazy">${overlays}</div></figure>`;
}

/* ------------------------------------------------------------- sections */

function renderHeader(scan: ScanRecord, dna: UiDnaDocument, attempts: readonly DiffReport[]): string {
  const meta: [string, string][] = [
    ['Scan id', scan.scanId],
    ['Target', `${dna.target.kind} ${dna.target.url}`],
    ['Scanned at', dna.target.scannedAt],
    ['Tool', `${dna.target.tool.name} ${dna.target.tool.version} (UI DNA ${dna.dnaVersion})`],
    ['Browser', `${scan.browser.name} (${scan.browser.mode})${scan.browser.version === null ? '' : ` ${scan.browser.version}`}`],
    ['Viewports', dna.target.viewports.map((v) => `${v.width}×${v.height}`).join(', ')],
    ['States', `${dna.states.items.length} (${dna.states.items.filter((s) => s.kind === 'base').length} base, ${dna.states.transitions.length} transitions)`],
  ];
  const rows = attempts.map((a) => [
    cell(a.attempt),
    cell(scan.steps.verify.find((v) => v.attempt === a.attempt)?.label ?? null),
    cell(a.createdAt),
    cell(a.summary.findings),
    cell(`${a.summary.bySeverity.high} high / ${a.summary.bySeverity.medium} medium / ${a.summary.bySeverity.low} low`),
    cell(a.regressions.length),
    cell(a.resolved.length),
    cell(`${a.summary.transitionsReplayed}/${a.summary.transitions} replayed, ${a.summary.transitionsMatched} matched`),
    cell(a.previousAttempt),
  ]);
  return [
    '<header>',
    '<h1>UI DNA reconstruction report</h1>',
    `<dl class="meta">${meta.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`,
    '<h2>Attempts</h2>',
    table(['attempt', 'label', 'created', 'findings', 'by severity', 'regressions', 'resolved', 'transitions', 'previous'], rows),
    '</header>',
  ].join('\n');
}

async function renderState(state: UiState, attempts: readonly DiffReport[], paths: ArtifactPaths): Promise<string> {
  const entries: { readonly attempt: DiffReport; readonly visual: VisualComparison }[] = [];
  for (const attempt of attempts) {
    const visual = attempt.visual.find((v) => v.stateId === state.id);
    if (visual !== undefined) entries.push({ attempt, visual });
  }
  const latest = entries.length > 0 ? entries[entries.length - 1] : undefined;
  const latestVisual: VisualComparison | null = latest?.visual ?? null;
  const originalSrc = await paths.relative(state.screenshot?.path ?? null);
  const generatedSrc = await paths.relative(latestVisual?.generatedScreenshot ?? null);
  const diffSrc = await paths.relative(latestVisual?.pixels?.diffImagePath ?? null);
  const originalSize = state.screenshot === null ? null : { width: state.screenshot.width, height: state.screenshot.height };
  const generatedSize = await paths.size(latestVisual?.generatedScreenshot ?? null);
  const boxes = latest === undefined ? null : await paths.boxes(latest.attempt.attempt, state.id);
  const toggleId = `overlay-${state.id}`;
  const rows = entries.map(({ attempt, visual: v }) => {
    return [
      cell(attempt.attempt),
      cell(v.pixels === null ? null : formatPercent(v.pixels.diffRatio)),
      cell(v.pixels?.ssim === null || v.pixels === null ? null : formatNumber(v.pixels.ssim, 4)),
      cell(v.pixels === null ? null : v.pixels.sizeMismatch ? 'yes' : 'no'),
      cell(`${v.geometry.matchedNodes}/${v.geometry.comparedNodes}`),
      cell(v.geometry.missingNodes),
      cell(v.geometry.extraNodes),
      cell(formatNumber(v.geometry.maxDriftPx, 2)),
      cell(`${v.styles.differingProperties}/${v.styles.comparedProperties}`),
      cell(v.findings.length),
    ];
  });
  return [
    `<section class="state"${attr('id', `state-${state.id}`)}>`,
    `<h3>${esc(state.id)} · ${state.viewport.width}×${state.viewport.height} · ${esc(state.title)}</h3>`,
    `<p class="muted">${esc(state.url)} · captured ${esc(state.capturedAt)} · ${state.nodeCount} nodes · document ${state.document.width}×${state.document.height}</p>`,
    `<input type="checkbox" class="toggle"${attr('id', toggleId)} checked><label${attr('for', toggleId)}>Show box overlays (<span class="legend-original">original</span>, <span class="legend-generated">generated</span>, <span class="legend-unmatched">unmatched original</span>)</label>`,
    '<div class="shots">',
    framed(originalSrc, `Original screenshot of ${state.id}`, 'Original', originalSize, boxes === null ? '' : overlay(boxes, originalSize, 'original')),
    framed(generatedSrc, `Generated screenshot of ${state.id}`, `Generated${latest === undefined ? '' : ` (attempt ${latest.attempt.attempt})`}`, generatedSize, boxes === null ? '' : overlay(boxes, generatedSize, 'generated')),
    image(diffSrc, `Pixel diff of ${state.id}`, 'Pixel diff (overlap)'),
    '</div>',
    boxes === null ? '<p class="muted">No box matches were stored for this state.</p>' : `<p class="muted">${boxes.filter((b) => b.generated !== null).length} matched boxes, ${boxes.filter((b) => b.generated === null).length} unmatched original boxes.</p>`,
    '<h4>Attempts</h4>',
    table(['attempt', 'pixel diff', 'SSIM', 'size mismatch', 'matched/compared', 'missing', 'extra', 'max drift px', 'style diffs', 'findings'], rows),
    latestVisual === null ? '' : `<h4>Findings (attempt ${latest?.attempt.attempt ?? 0})</h4>${findingsTable(latestVisual.findings)}`,
    latestVisual === null || latestVisual.limitations.length === 0 ? '' : `<h4>Limitations</h4><ul>${latestVisual.limitations.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`,
    '</section>',
  ].join('\n');
}

function tokenRows(tokens: readonly Token[], swatch: boolean): string[][] {
  return tokens.map((t) => {
    const value = t.value.value;
    const color = swatch && value !== null ? safeCssColor(value) : null;
    const valueCell = color === null ? cell(attributedText(t.value)) : `<td><span class="swatch"${attr('style', `background:${color}`)}></span>${esc(value ?? '')}</td>`;
    return [
      cell(t.id),
      cell(t.generatedName),
      cell(t.name?.value ?? null),
      valueCell,
      cell(t.cluster.sampleCount),
      cell(t.cluster.members.map((m) => `${m.value} (${m.count})`).join(', ')),
      cell(t.cluster.properties.join(', ')),
      cell(t.value.provenance.kind),
    ];
  });
}

function typographyRows(styles: readonly TypographyStyle[]): string[][] {
  return styles.map((s) => [
    cell(s.id),
    cell(s.generatedName),
    cell(s.name?.value ?? null),
    cell(attributedText(s.fontFamily)),
    cell(attributedText(s.fontSize)),
    cell(attributedText(s.fontWeight)),
    cell(attributedText(s.lineHeight)),
    cell(s.letterSpacing === undefined ? null : attributedText(s.letterSpacing)),
    cell(s.textTransform === undefined ? null : attributedText(s.textTransform)),
    cell(s.sampleCount),
    cell(provenanceKind(s.fontFamily)),
  ]);
}

function renderTokens(dna: UiDnaDocument): string {
  const { tokens } = dna.visual;
  const headers = ['id', 'generated name', 'agent name', 'value', 'samples', 'cluster members', 'properties', 'provenance'];
  const group = (title: string, list: readonly Token[], swatch = false): string => `<h3>${esc(title)} (${list.length})</h3>${table(headers, tokenRows(list, swatch))}`;
  return [
    '<section id="tokens"><h2>Tokens</h2>',
    group('Colors', tokens.colors, true),
    `<h3>Typography (${tokens.typography.length})</h3>${table(['id', 'generated name', 'agent name', 'family', 'size', 'weight', 'line height', 'letter spacing', 'transform', 'samples', 'provenance'], typographyRows(tokens.typography))}`,
    group('Font families', tokens.fontFamilies),
    group('Font sizes', tokens.fontSizes),
    group('Spacing', tokens.spacing),
    group('Radii', tokens.radii),
    group('Shadows', tokens.shadows),
    group('Breakpoints', tokens.breakpoints),
    '</section>',
  ].join('\n');
}

function renderComponents(dna: UiDnaDocument): string {
  const rows = dna.components.definitions.map((d) => [
    cell(d.id),
    cell(d.generatedName),
    cell(d.name?.value ?? null),
    cell(d.structure.signature),
    cell(`${d.structure.tag}${d.structure.role === null ? '' : ` (${d.structure.role})`}`),
    cell(d.instanceCount),
    cell(Object.entries(d.matchesByState).map(([s, n]) => `${s}: ${n}`).join(', ')),
    cell(d.variants.length),
    cell(formatNumber(d.confidence, 2)),
    cell(d.provenance.kind),
  ]);
  return `<section id="components"><h2>Component candidates (${dna.components.definitions.length})</h2>${table(['id', 'generated name', 'agent name', 'signature', 'tag (role)', 'instances', 'per state', 'variants', 'confidence', 'provenance'], rows)}</section>`;
}

async function renderBehavior(latest: DiffReport | null, dna: UiDnaDocument, paths: ArtifactPaths): Promise<string> {
  if (latest === null || latest.behavioral.length === 0) {
    return `<section id="behavior"><h2>Behavior replay</h2><p class="muted">${dna.states.transitions.length === 0 ? 'No transitions were recorded; run explore_interactions to observe some.' : 'No verification attempt replayed the recorded transitions yet.'}</p></section>`;
  }
  const statesById = new Map(dna.states.items.map((s) => [s.id, s] as const));
  const blocks: string[] = [];
  for (const b of latest.behavioral) {
    const to = statesById.get(b.toStateId);
    const originalSrc = await paths.relative(to?.screenshot?.path ?? null);
    const afterSrc = await paths.relative(b.generatedScreenshot);
    const diffSrc = await paths.relative(b.pixels?.diffImagePath ?? null);
    const target = b.action.target;
    const targetText = target === null ? 'no target' : `${target.role ?? target.tag}${target.name === null ? '' : ` "${target.name}"`} at ${target.nodePath === '' ? '(body)' : target.nodePath}`;
    const action = `${b.action.type}${b.action.key === undefined ? '' : ` ${b.action.key}`}`;
    const facts: [string, string][] = [
      ['Action', `${action} on ${targetText}`],
      ['States', `${b.fromStateId} → ${b.toStateId} at ${b.viewport.width}×${b.viewport.height}`],
      ['Locator', `role ${b.locator.role ?? '—'}, name ${b.locator.name ?? '—'}, nth ${b.locator.nth}`],
      ['Replayed', b.replayed ? 'yes' : `no${b.reason === null ? '' : ` (${b.reason})`}`],
      ['Role tree match', b.roleTreeMatch === null ? 'not compared' : b.roleTreeMatch ? 'yes' : 'no'],
      ['Missing after replay', b.roleTreeDiff.missing.length === 0 ? 'none' : b.roleTreeDiff.missing.join(', ')],
      ['Extra after replay', b.roleTreeDiff.extra.length === 0 ? 'none' : b.roleTreeDiff.extra.join(', ')],
      ['Pixels vs original to-state', b.pixels === null ? 'not compared' : `${formatPercent(b.pixels.diffRatio)} differ${b.pixels.ssim === null ? '' : `, SSIM ${formatNumber(b.pixels.ssim, 4)}`}${b.pixels.sizeMismatch ? ' (size mismatch, overlap compared)' : ''}`],
    ];
    blocks.push(
      [
        `<article class="transition"${attr('id', `transition-${b.transitionId}`)}>`,
        `<h3>${esc(b.transitionId)}</h3>`,
        `<dl class="meta">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`,
        '<div class="shots">',
        image(originalSrc, `Original screenshot of ${b.toStateId}`, `Original ${b.toStateId}`),
        image(afterSrc, `Generated app after ${b.transitionId}`, 'Generated after replay'),
        image(diffSrc, `Pixel diff after ${b.transitionId}`, 'Pixel diff'),
        '</div>',
        b.findings.length === 0 ? '' : findingsTable(b.findings, true),
        '</article>',
      ].join('\n'),
    );
  }
  return `<section id="behavior"><h2>Behavior replay (attempt ${latest.attempt})</h2>${blocks.join('\n')}</section>`;
}

function renderLimitations(scan: ScanRecord, dna: UiDnaDocument, latest: DiffReport | null): string {
  const docRows = dna.limitations.map((l) => [cell(l.kind), cell(l.subject), cell(l.reason), cell(l.stateId ?? null), cell(l.nodePath ?? null)]);
  const list = (items: readonly string[]): string => (items.length === 0 ? '<p class="muted">None.</p>' : `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>`);
  return [
    '<section id="limitations"><h2>Limitations and unknowns</h2>',
    `<h3>Document limitations (${dna.limitations.length})</h3>`,
    table(['kind', 'subject', 'reason', 'state', 'node path'], docRows),
    `<h3>Scan limitations (${scan.limitations.length})</h3>`,
    list(scan.limitations),
    `<h3>Scan unknowns (${scan.unknowns.length})</h3>`,
    list(scan.unknowns),
    latest === null ? '<p class="muted">No verification attempt yet.</p>' : `<h3>Attempt ${latest.attempt} limitations (${latest.limitations.length})</h3>${list(latest.limitations)}<h3>Attempt ${latest.attempt} unknowns (${latest.unknowns.length})</h3>${list(latest.unknowns)}`,
    '</section>',
  ].join('\n');
}

function renderLegend(): string {
  return [
    '<section id="provenance"><h2>Provenance legend</h2>',
    '<dl class="meta">',
    '<dt>measured</dt><dd>Read directly by the instrument from computed styles, bounding boxes, the accessibility tree, the network or a screenshot.</dd>',
    '<dt>observed</dt><dd>Seen by the instrument as an outcome (an interaction changed the page, a value changed between viewports) rather than measured as a number.</dd>',
    '<dt>inferred</dt><dd>Written by the host agent through annotate_dna. The measured value is kept alongside; this report shows agent names next to generated ones.</dd>',
    '<dt>unknown</dt><dd>Could not be obtained; the reason is recorded instead of a value. Nothing in this report is invented to fill a gap.</dd>',
    '</dl>',
    '</section>',
  ].join('\n');
}

const STYLES = `
:root { color-scheme: light; --ink: #1b1f2a; --muted: #5b6474; --line: #dfe3ec; --bg: #ffffff; --surface: #f5f7fb; --original: #2f5bea; --generated: #d98a1f; --unmatched: #c0392b; }
* { box-sizing: border-box; }
body { margin: 0; padding: 24px; font: 14px/1.5 "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; color: var(--ink); background: var(--bg); }
h1 { font-size: 24px; margin: 0 0 16px; } h2 { font-size: 20px; margin: 32px 0 12px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
h3 { font-size: 16px; margin: 20px 0 8px; } h4 { font-size: 14px; margin: 16px 0 6px; color: var(--muted); }
.meta { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 12px; } .meta dt { color: var(--muted); } .meta dd { margin: 0; word-break: break-word; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 13px; } th, td { border: 1px solid var(--line); padding: 4px 8px; text-align: left; vertical-align: top; } th { background: var(--surface); }
td.msg { max-width: 420px; } td.muted, .muted { color: var(--muted); }
.swatch { display: inline-block; width: 14px; height: 14px; border: 1px solid var(--line); border-radius: 3px; vertical-align: middle; margin-right: 6px; }
.tag, .sev { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 12px; background: var(--surface); }
.sev-high { background: #fdecea; color: #a12622; } .sev-medium { background: #fff4e0; color: #8a5a00; } .sev-low { background: #eef3ff; color: #2448bf; }
section.state, article.transition { border: 1px solid var(--line); border-radius: 12px; padding: 16px; margin: 16px 0; background: var(--bg); }
.shots { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin: 12px 0; }
figure { margin: 0; } figcaption { color: var(--muted); font-size: 12px; margin-bottom: 4px; } figure img { display: block; width: 100%; height: auto; border: 1px solid var(--line); }
.frame { position: relative; overflow: hidden; } .frame img { width: 100%; }
.overlay { position: absolute; inset: 0; pointer-events: none; } .box { position: absolute; border: 1px solid; } .box-original { border-color: var(--original); } .box-generated { border-color: var(--generated); } .box-unmatched { border-color: var(--unmatched); border-style: dashed; }
.toggle { margin-right: 6px; } .toggle:not(:checked) ~ .shots .overlay { display: none; }
.legend-original { color: var(--original); } .legend-generated { color: var(--generated); } .legend-unmatched { color: var(--unmatched); }
ul { padding-left: 20px; }
`;

/** Write the static HTML report for a scan. */
export async function renderReport(input: RenderReportInput): Promise<Result<RenderedReport>> {
  const { ctx, scan, dna } = input;
  const attempts = [...input.attempts].sort((a, b) => a.attempt - b.attempt);
  const latest = attempts.length > 0 ? (attempts[attempts.length - 1] ?? null) : null;
  const outPath = isAbsolute(input.outPath) ? input.outPath : resolve(ctx.cwd, input.outPath);
  const paths = new ArtifactPaths(ctx, scan.scanId, dirname(outPath));
  const baseStates = dna.states.items.filter((s) => s.kind === 'base').sort((a, b) => b.viewport.width - a.viewport.width || compareStrings(a.id, b.id));

  const stateSections: string[] = [];
  for (const state of baseStates) stateSections.push(await renderState(state, attempts, paths));

  const html = [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>UI DNA report · ${esc(scan.scanId)}</title>`,
    `<style>${STYLES}</style>`,
    '</head>',
    '<body>',
    renderHeader(scan, dna, attempts),
    '<main>',
    `<section id="states"><h2>Base states (${baseStates.length})</h2>`,
    ...stateSections,
    '</section>',
    renderTokens(dna),
    renderComponents(dna),
    await renderBehavior(latest, dna, paths),
    renderLimitations(scan, dna, latest),
    renderLegend(),
    '</main>',
    '</body>',
    '</html>',
    '',
  ].join('\n');

  try {
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, html, 'utf8');
  } catch (cause) {
    return err(toError(cause, 'io', `write report ${outPath}`));
  }
  return ok({ path: outPath, attempts: attempts.length, findings: latest === null ? 0 : latest.summary.findings, states: baseStates.length });
}
