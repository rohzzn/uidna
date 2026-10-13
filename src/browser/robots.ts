/**
 * robots.txt support for launch mode. UI DNA identifies itself as `uidna`;
 * the group for `uidna` wins over the `*` group, and within a group the
 * longest matching path wins (Allow beats Disallow on ties). An unreachable
 * or missing robots.txt means everything is allowed. Attach mode never
 * consults robots.txt: the user is browsing their own session.
 */
import { toError, uidnaError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

/** The user-agent token UI DNA matches in robots.txt. */
export const ROBOTS_AGENT = 'uidna';

/** One Allow or Disallow line. */
export interface RobotsRule {
  readonly type: 'allow' | 'disallow';
  readonly path: string;
}

/** A group of rules that applies to a set of user agents. */
export interface RobotsGroup {
  readonly agents: readonly string[];
  readonly rules: readonly RobotsRule[];
}

/** Outcome of checking one URL. */
export interface RobotsDecision {
  readonly allowed: boolean;
  /** The rule that decided, or null when no rule matched or the file was absent. */
  readonly rule: RobotsRule | null;
  /** The user-agent token of the group that applied, or null. */
  readonly agent: string | null;
  /** Why the decision was made, in plain words. */
  readonly reason: string;
}

/** A fetched robots.txt. */
export interface RobotsFile {
  readonly origin: string;
  readonly status: 'ok' | 'missing' | 'unreachable';
  readonly groups: readonly RobotsGroup[];
  readonly detail: string;
}

/** Parse robots.txt text into groups. Unknown directives are ignored. */
export function parseRobots(text: string): RobotsGroup[] {
  const groups: { agents: string[]; rules: RobotsRule[] }[] = [];
  let current: { agents: string[]; rules: RobotsRule[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const directive = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (directive === 'user-agent') {
      if (!lastWasAgent || current === null) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (current === null) continue;
    if (directive === 'allow' || directive === 'disallow') {
      current.rules.push({ type: directive, path: value });
    }
  }
  return groups;
}

/** Select the group that applies to `agent`: the most specific agent token, else `*`, else null. */
export function selectGroup(groups: readonly RobotsGroup[], agent: string = ROBOTS_AGENT): { group: RobotsGroup; agent: string } | null {
  const token = agent.toLowerCase();
  let best: { group: RobotsGroup; agent: string; score: number } | null = null;
  for (const group of groups) {
    for (const candidate of group.agents) {
      let score = -1;
      if (candidate === token) score = 3;
      else if (candidate !== '*' && token.startsWith(candidate)) score = 2;
      else if (candidate !== '*' && candidate.startsWith(token)) score = 1;
      else if (candidate === '*') score = 0;
      if (score >= 0 && (best === null || score > best.score)) best = { group, agent: candidate, score };
    }
  }
  if (best === null) return null;
  // Merge every group that names the winning token so split groups behave as one.
  const rules = groups.filter((g) => g.agents.includes(best.agent)).flatMap((g) => g.rules);
  return { group: { agents: [best.agent], rules }, agent: best.agent };
}

/** Evaluate a URL against parsed groups using longest-match semantics. */
export function evaluateRobots(groups: readonly RobotsGroup[], url: string, agent: string = ROBOTS_AGENT): RobotsDecision {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return { allowed: true, rule: null, agent: null, reason: 'URL could not be parsed; no robots rule applied' };
  }
  const selected = selectGroup(groups, agent);
  if (selected === null) return { allowed: true, rule: null, agent: null, reason: 'No robots.txt group applies to uidna' };
  const subject = target.pathname + target.search;
  let winner: { rule: RobotsRule; length: number } | null = null;
  for (const rule of selected.group.rules) {
    if (rule.path === '') continue; // "Disallow:" (empty) allows everything.
    if (!matchesRobotsPath(rule.path, subject)) continue;
    const length = rule.path.length;
    if (winner === null || length > winner.length || (length === winner.length && rule.type === 'allow' && winner.rule.type === 'disallow')) {
      winner = { rule, length };
    }
  }
  if (winner === null) return { allowed: true, rule: null, agent: selected.agent, reason: `No rule in the "${selected.agent}" group matches ${subject}` };
  const allowed = winner.rule.type === 'allow';
  return {
    allowed,
    rule: winner.rule,
    agent: selected.agent,
    reason: `${allowed ? 'Allow' : 'Disallow'}: ${winner.rule.path} (user-agent: ${selected.agent})`,
  };
}

/** Match a robots path pattern (`*` wildcard, `$` end anchor) against a path. */
export function matchesRobotsPath(pattern: string, subject: string): boolean {
  let anchored = false;
  let source = pattern;
  if (source.endsWith('$')) {
    anchored = true;
    source = source.slice(0, -1);
  }
  const parts = source.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'));
  const regex = new RegExp(`^${parts.join('.*')}${anchored ? '$' : ''}`);
  return regex.test(subject);
}

/** Minimal fetch shape so tests can inject a fake. */
export type FetchLike = (url: string, init: { signal: AbortSignal; redirect: 'follow' }) => Promise<{ status: number; text(): Promise<string> }>;

/** Fetch and parse `<origin>/robots.txt`. Never throws: failures become `unreachable`. */
export async function fetchRobots(origin: string, options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<RobotsFile> {
  const fetchImpl: FetchLike = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? 2000;
  const url = `${origin}/robots.txt`;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'follow' });
    if (response.status >= 200 && response.status < 300) {
      const text = await response.text();
      return { origin, status: 'ok', groups: parseRobots(text), detail: `${url} fetched (${response.status})` };
    }
    if (response.status === 404 || response.status === 410) {
      return { origin, status: 'missing', groups: [], detail: `${url} returned ${response.status}; everything allowed` };
    }
    return { origin, status: 'unreachable', groups: [], detail: `${url} returned ${response.status}; treated as allowed` };
  } catch (cause) {
    const error = toError(cause, 'navigation');
    return { origin, status: 'unreachable', groups: [], detail: `${url} unreachable (${error.message}); treated as allowed` };
  }
}

/** Per-origin cache of robots.txt decisions for one session. */
export class RobotsCache {
  private readonly files = new Map<string, Promise<RobotsFile>>();

  constructor(private readonly options: { fetchImpl?: FetchLike; timeoutMs?: number; agent?: string } = {}) {}

  /** The parsed file for an origin, fetched once. */
  file(origin: string): Promise<RobotsFile> {
    let pending = this.files.get(origin);
    if (!pending) {
      pending = fetchRobots(origin, this.options);
      this.files.set(origin, pending);
    }
    return pending;
  }

  /**
   * Check a URL. Returns a `policy` error when robots.txt disallows it,
   * naming the matched rule; every other outcome (allowed, missing,
   * unreachable) is `ok`.
   */
  async check(url: string): Promise<Result<RobotsDecision>> {
    let origin: string;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return ok({ allowed: true, rule: null, agent: null, reason: `robots.txt does not apply to ${parsed.protocol} URLs` });
      }
      origin = parsed.origin;
    } catch (cause) {
      return err(toError(cause, 'validation', `Invalid URL ${url}`));
    }
    const file = await this.file(origin);
    if (file.status !== 'ok') return ok({ allowed: true, rule: null, agent: null, reason: file.detail });
    const decision = evaluateRobots(file.groups, url, this.options.agent ?? ROBOTS_AGENT);
    if (!decision.allowed) {
      return err(
        uidnaError('policy', `robots.txt at ${origin} disallows ${url}: ${decision.reason}`, {
          details: { url, origin, rule: decision.rule, agent: decision.agent },
        }),
      );
    }
    return ok(decision);
  }
}
