/**
 * Helpers for running typed functions inside the page.
 *
 * In-page functions are written as ordinary TypeScript functions so they
 * are type-checked, then shipped to the browser as source text. When the
 * module is executed through esbuild-based loaders (tsx, vitest) the source
 * of a function that contains nested named functions carries `__name(...)`
 * calls that do not exist in the page. `pageExpression` wraps the source in
 * one expression that defines `__name` as an identity parameter, so the same
 * code runs identically under tsx, vitest and the compiled build.
 *
 * Arguments are embedded as JSON literals: they are data, never code, and
 * only values UI DNA produced itself (paths, property names) are passed.
 */
import type { JSHandle, Page } from 'playwright';

/** Source of `fn(arg)` as a single self-contained expression. */
export function pageExpression<Arg>(fn: (arg: Arg) => unknown, arg?: Arg): string {
  const literal = arg === undefined ? 'undefined' : JSON.stringify(arg);
  return `((__name) => (${fn.toString()})(${literal}))((f) => f)`;
}

/** Evaluate `fn(arg)` in the page's main frame. The result is untyped: callers validate it with Zod. */
export function evaluateInPage<Arg>(page: Page, fn: (arg: Arg) => unknown, arg?: Arg): Promise<unknown> {
  return page.evaluate(pageExpression(fn, arg));
}

/** Evaluate `fn(arg)` and keep the result as a handle (for element resolution). */
export function evaluateHandleInPage<Arg>(page: Page, fn: (arg: Arg) => unknown, arg?: Arg): Promise<JSHandle<unknown>> {
  return page.evaluateHandle(pageExpression(fn, arg));
}

/** Register `fn()` to run on every new document of the page. */
export async function addInitScriptInPage(page: Page, fn: () => unknown): Promise<void> {
  await page.addInitScript(pageExpression(fn));
}
