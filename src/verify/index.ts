/**
 * Verification layer: renders the generated project page by page, compares it
 * with the original captures, replays recorded transitions (including
 * navigations, fills and submits), optionally runs the generated Playwright
 * tests, and writes the DiffReport and the static HTML report. Deterministic
 * and agent-free.
 */
export { verifyReconstruction, generatedUrl, pathSelector, textSelector, traceToBase, navigationExclusion, submitExclusion, neverReplayed, MAX_REPLAY_CHAIN } from './verify.js';
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
export { pageOf, pageRoute, isLiteralRoute, routeReached, pathnameOf, orderByPage } from './pages.js';
export {
  runGeneratedTests,
  parsePlaywrightReport,
  transitionIdOfTitle,
  errorExcerpt,
  GeneratedTestRunSchema,
  GeneratedTestResultSchema,
  GENERATED_TESTS_FILE,
  GENERATED_TESTS_RAW_FILE,
  GENERATED_TESTS_LOG_FILE,
  GENERATED_TESTS_SCRIPT,
  GENERATED_TESTS_TIMEOUT_MS,
  MAX_ERROR_EXCERPT,
} from './generated-tests.js';
export type { GeneratedTestRun, GeneratedTestResult, GeneratedTestsInput, GeneratedTestsOutcome, ParsedReport } from './generated-tests.js';
