/**
 * Verification layer: renders the generated project, compares it with the
 * original captures, replays recorded transitions and writes the DiffReport
 * and the static HTML report. Deterministic and agent-free.
 */
export { verifyReconstruction, generatedUrl, pathSelector, textSelector } from './verify.js';
export type { VerifyInput } from './verify.js';
export { renderReport } from './report.js';
export type { RenderReportInput, RenderedReport } from './report.js';
export { comparePixels, decodePng, encodePng, toPixelComparison } from './pixels.js';
export type { ImageSize, PixelDiff, PixelDiffOptions } from './pixels.js';
export { matchNodes, derivedGeneratedPaths, normalizeName, normalizeText, placeholderOf, boxDrift, isMountNode, PATH_ATTRIBUTE, PLACEHOLDER_ATTRIBUTE } from './match.js';
export type { Counterpart, DerivedPath, MatchResult, MatchStrategy, NodeMatch, NodeSource } from './match.js';
export { diffRoleTrees, compareDeltas, roleTreeEntries, roleTreeEntry } from './roles.js';
export type { DeltaComparison, RoleTreeDelta } from './roles.js';
export { compareStyles, firstFontFamily, COLOR_PROPERTIES, TYPOGRAPHY_PROPERTIES, LAYOUT_PROPERTIES } from './styles.js';
export type { StyleCategory, StyleComparison, StyleDifference, StyleThresholds } from './styles.js';
export { findingKey, diffAttempts, allFindings, countFindings, findTokenId, findComponentId, severityRank, FindingCounter } from './findings.js';
export type { AttemptDiff } from './findings.js';
export { escapeHtml, escapeAttr, attr, safeCssColor, formatNumber, formatPercent } from './html.js';
