/**
 * Explore layer: performs the interactions of a scan's base states, page by
 * page, and records derived states and transitions. The policies live in
 * `domain/safe-policy.ts`; this module drives the browser: ordinary safe
 * actions (`explorer.ts`), navigation clicks to crawled pages
 * (`navigation.ts`) and the forms policy's fill and submit chains
 * (`forms.ts`).
 */
export * from './explorer.js';
export { SUBMIT_SKIPPED_EARLIER, TARGET_MOVED } from './forms.js';
export { NAVIGATION_SKIPPED_EARLIER } from './navigation.js';
export { effectKey, keyPressEffectKey, type ExplorePolicy, type PageCoverage } from './run.js';
