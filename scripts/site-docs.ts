/**
 * Generates the docs pages of the website (`website/docs/**`) from `docs/tools.md`,
 * `docs/ui-dna.md`, the README, the changelog and the CLI sources, so the site never drifts
 * from the tools. `website/docs/docs.css` and `docs.js` are hand-written and not touched.
 * `--check` exits non-zero when the committed pages are stale.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const outRoot = join(repoRoot, 'website', 'docs');
const GH = 'https://github.com/rohzzn/uidna/blob/main/';
const SITE = 'https://uidna.fun/docs/';
const FONTS = 'https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&amp;family=Martian+Mono:wdth,wght@75..112.5,100..800&amp;display=swap';
const GENERATED_DIRS = ['how-it-works', 'tools', 'cli', 'document', 'changelog'];

const read = (path: string): Promise<string> => readFile(join(repoRoot, path), 'utf8');
const TOOLS_MD = await read('docs/tools.md');
const DNA_MD = await read('docs/ui-dna.md');
const README = await read('README.md');
const CHANGELOG = await read('CHANGELOG.md');
const CLI_TS = await read('src/cli.ts');
const SETUP_TS = await read('src/cli/setup-commands.ts');
const CONFIG_TS = await read('src/application/config.ts');
const PKG = await read('package.json');
const VERSION = (JSON.parse(PKG) as { version?: string }).version ?? '';

// ─── text helpers ───
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const attr = (s: string): string => esc(s).replace(/"/g, '&quot;');
const slug = (s: string): string => s.toLowerCase().replace(/\(.*?\)/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const pad2 = (n: number): string => String(n).padStart(2, '0');

/** Repository files that have a page on the site, keyed by their path. */
const SITE_PAGES: Record<string, string> = { 'docs/tools.md': 'tools/', 'docs/ui-dna.md': 'document/', 'CHANGELOG.md': 'changelog/' };

function highlightJson(src: string): string {
  const re = /"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|\b(?:true|false|null)\b/g;
  let out = '';
  let pos = 0;
  for (let m = re.exec(src); m !== null; m = re.exec(src)) {
    out += esc(src.slice(pos, m.index));
    const tok = m[0];
    const cls = tok.startsWith('"') ? (/^\s*:/.test(src.slice(m.index + tok.length)) ? 'k' : 's') : ['true', 'false', 'null'].includes(tok) ? 'b' : 'n';
    out += `<span class="${cls}">${esc(tok)}</span>`;
    pos = m.index + tok.length;
  }
  return out + esc(src.slice(pos));
}

function highlightBash(src: string): string {
  let cont = false;
  return src
    .split('\n')
    .map((line) => {
      if (line.trim().startsWith('#')) {
        cont = false;
        return `<span class="c">${esc(line)}</span>`;
      }
      const body = esc(line).replace(/(\s#\s.*)$/, '<span class="c">$1</span>');
      const out = line.trim() ? (cont ? '  ' : '<span class="p">$ </span>') + body : '';
      cont = line.trimEnd().endsWith('\\');
      return out;
    })
    .join('\n');
}

const COPY_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 5.5h8v8h-8z" fill="none" stroke="currentColor" stroke-width="1.3"></path><path d="M10.5 5.5v-3h-8v8h3" fill="none" stroke="currentColor" stroke-width="1.3"></path></svg>';
const copyButton = (text: string): string => `<button type="button" class="d-copy" data-copy="${attr(text)}" aria-label="Copy">${COPY_ICON}Copy</button>`;

/** Renders markdown and components for one page, resolving links relative to its depth. */
class Renderer {
  constructor(readonly depth: number) {}

  rel(path: string): string {
    return '../'.repeat(this.depth) + path;
  }

  link(href: string, base: string): string {
    if (/^(https?:|mailto:|#)/.test(href)) return href;
    const [file = '', hash] = href.split('#');
    const repoPath = posix.normalize(posix.join(base, file));
    const site = SITE_PAGES[repoPath];
    const tail = hash ? `#${hash}` : '';
    return site !== undefined ? this.rel(site) + tail : GH + repoPath + tail;
  }

  plain(s: string): string {
    return s
      .split(/(`[^`]+`)/)
      .map((part) => (part.length > 1 && part.startsWith('`') && part.endsWith('`') ? `<code>${esc(part.slice(1, -1))}</code>` : esc(part).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')))
      .join('');
  }

  inline(s: string, base = ''): string {
    const links: string[] = [];
    const held = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
      links.push(`<a class="d-a" href="${attr(this.link(href, base))}">${this.plain(label)}</a>`);
      return `${links.length - 1}`;
    });
    return this.plain(held).replace(/(\d+)/g, (_m, i: string) => links[Number(i)] ?? '');
  }

  code(lang: string, src: string, label?: string): string {
    const l = lang.toLowerCase();
    if (l === 'bash' || l === 'sh') {
      const text = src.split('\n').filter((x) => x.trim() && !x.trim().startsWith('#')).join('\n');
      return this.block('d-code term', label ?? 'bash', text, highlightBash(src));
    }
    if (l === 'prompt') return this.block('d-code term', label ?? 'prompt', src, esc(src));
    if (l === 'json') return this.block('d-code', label ?? 'json', src, highlightJson(src));
    return this.block('d-code', label ?? (l || 'text'), src, esc(src));
  }

  private block(cls: string, label: string, text: string, body: string): string {
    return `<div class="${cls}"><div class="d-code-bar"><p class="d-lab">${esc(label)}</p>${copyButton(text)}</div><pre>${body}</pre></div>`;
  }

  table(head: string[], rows: string[][], typeCol?: number): string {
    const th = head.map((h) => `<th>${esc(h)}</th>`).join('');
    const tr = rows.map((r) => `<tr>${r.map((c, i) => `<td${i === typeCol ? ' class="t"' : ''}>${c}</td>`).join('')}</tr>`).join('');
    return `<div class="d-tbl"><table><thead><tr>${th}</tr></thead><tbody>${tr}</tbody></table></div>`;
  }

  /** Block markdown (h3, paragraphs, fences, tables, lists); `##` is split off by the caller. */
  markdown(md: string, base: string): string {
    const out: string[] = [];
    const lines = md.split('\n');
    let para: string[] = [];
    const flush = (): void => {
      if (para.length) out.push(`<p>${this.inline(para.map((x) => x.trim()).join(' '), base)}</p>`);
      para = [];
    };
    for (let i = 0; i < lines.length; ) {
      const line = lines[i] ?? '';
      if (line.startsWith('```')) {
        flush();
        const lang = line.slice(3).trim();
        const buf: string[] = [];
        let j = i + 1;
        for (; j < lines.length && !(lines[j] ?? '').startsWith('```'); j += 1) buf.push(lines[j] ?? '');
        out.push(this.code(lang, buf.join('\n')));
        i = j + 1;
      } else if (line.startsWith('|')) {
        flush();
        const rows: string[][] = [];
        for (; i < lines.length && (lines[i] ?? '').startsWith('|'); i += 1) {
          rows.push((lines[i] ?? '').trim().split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, '|')));
        }
        out.push(this.table(rows[0] ?? [], rows.slice(2).map((r) => r.map((c) => this.inline(c, base)))));
      } else if (line.startsWith('### ')) {
        flush();
        out.push(`<h3 class="d-h3">${this.inline(line.slice(4), base)}</h3>`);
        i += 1;
      } else if (/^\s*- /.test(line)) {
        flush();
        const items: string[] = [];
        for (; i < lines.length; i += 1) {
          const l = lines[i] ?? '';
          if (/^\s*- /.test(l)) items.push(l.trim().slice(2));
          else if (l.startsWith('  ') && l.trim() && items.length) items[items.length - 1] += ' ' + l.trim();
          else break;
        }
        out.push(`<ul class="d-list">${items.map((x) => `<li>${this.inline(x, base)}</li>`).join('')}</ul>`);
      } else if (/^\[[^\]]+\]: /.test(line) || line.startsWith('<!--')) {
        flush();
        i += 1;
      } else if (!line.trim()) {
        flush();
        i += 1;
      } else {
        para.push(line);
        i += 1;
      }
    }
    flush();
    return out.join('\n');
  }
}

/** The text of a `## title` section of a markdown file, up to the next `## `. */
function section(md: string, title: string): string {
  const start = md.indexOf(`\n## ${title}\n`);
  if (start < 0) throw new Error(`section "${title}" not found`);
  const body = md.slice(start + title.length + 5);
  const end = body.search(/\n## /);
  return end < 0 ? body : body.slice(0, end);
}

const h2 = (num: string, title: string, id: string, tail = ''): string => `<h2 class="d-h2" id="${id}"><span>${num}</span>${title}${tail}</h2>`;
const note = (n: string, label: string, body: string, warn = false): string =>
  `<div class="d-note${warn ? ' warn' : ''}"><b class="n">${n}</b><div><p class="d-lab"><b>${label}</b></p><p>${body}</p></div></div>`;
const steps = (items: [string, string][]): string =>
  `<ol class="d-steps">${items.map(([a, b], k) => `<li><i>${k + 1}</i><div><b>${a}</b><span>${b}</span></div></li>`).join('')}</ol>`;
const crumb = (...parts: string[]): string =>
  `<div class="d-crumb">${parts.map((p, i) => `${i ? '<i></i>' : ''}<p class="d-lab">${i ? esc(p) : `<b>${esc(p)}</b>`}</p>`).join('')}</div>`;

// ─── tools ───
interface Tool {
  name: string;
  title: string;
  shape: string;
  cli: string;
  desc: string;
  effects: string;
  inputs: string[][];
  results: string[];
}

const TOOLS: Tool[] = [...TOOLS_MD.matchAll(/^### `([a-z_]+)`\n([\s\S]*?)(?=^### `|$(?![\s\S]))/gm)].map((m) => {
  const name = m[1] ?? '';
  const sec = m[2] ?? '';
  const head = /\*\*(.+?)\*\* — shape: `(\w+)` — CLI: `([^`]+)`/.exec(sec);
  const inputs = /\*\*Input\*\*\n\n([\s\S]*?)\n\n/.exec(sec)?.[1] ?? '';
  const results = /\*\*Result fields\*\*\n\n(.+)/.exec(sec)?.[1] ?? '';
  return {
    name,
    title: head?.[1] ?? name,
    shape: head?.[2] ?? '',
    cli: head?.[3] ?? '',
    desc: sec.split('\n\n')[1]?.trim() ?? '',
    effects: /^Effects: (.+)$/m.exec(sec)?.[1] ?? '',
    inputs: inputs.split('\n').slice(2).map((l) => l.trim().split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, '|'))),
    results: [...results.matchAll(/`([^`]+)`/g)].map((r) => r[1] ?? ''),
  };
});
const GROUP: Record<string, string> = {
  scan_interface: 'Look', explore_interactions: 'Look', inspect_dna: 'Read', inspect_element: 'Read', search_components: 'Read', extract_tokens: 'Read',
  annotate_dna: 'Build', generate_project: 'Build', verify_reconstruction: 'Prove', report_reconstruction: 'Prove', export_evidence: 'Prove', reconstruct_interface: 'Loop',
};
const TONE: Record<string, string> = { Look: 'blue', Read: 'green', Build: 'amber', Prove: 'red', Loop: 'ink' };
const CLI_ONLY = [...TOOLS_MD.matchAll(/^\| _\(CLI only\)_ \| \w+ \| `(uidna \w+)` — (.+) \|$/gm)].map((m) => ({ cmd: m[1] ?? '', what: m[2] ?? '' }));

// ─── pages ───
interface TocEntry { num: string; title: string; id: string }
interface Page { path: string; title: string; description: string; spec: string; source: string; body: (r: Renderer) => string; toc: TocEntry[]; aside?: (r: Renderer) => string }

const DNA_PARTS = DNA_MD.split(/^## (.+)$/m);
const DNA_SECTIONS: TocEntry[] = [];
for (let k = 1; k < DNA_PARTS.length; k += 2) {
  const title = (DNA_PARTS[k] ?? '').trim();
  DNA_SECTIONS.push({ num: `05.${(k + 1) / 2}`, title: title.replace(/\s*\(.*?\)/, ''), id: slug(title) });
}
const VERSIONS = [...CHANGELOG.matchAll(/^## \[([\d.]+)\] - (\S+)$/gm)].map((m) => ({ v: m[1] ?? '', date: m[2] ?? '' }));
const HOW: [string, string, string][] = [['02.1', 'The loop', 'How it works'], ['02.2', 'What ships', 'What ships today'], ['02.3', 'Authorized use', 'Authorized use'], ['02.4', 'Limitations', 'Limitations']];

function options(source: string, from: string, to?: string): [string, string][] {
  const start = source.indexOf(from);
  const end = to ? source.indexOf(to, start + 1) : source.length;
  const block = source.slice(start, end < 0 ? source.length : end);
  return [...block.matchAll(/\.option\('([^']+)', '([^']+)'\)/g)]
    .map((m): [string, string] => [m[1] ?? '', m[2] ?? ''])
    .filter(([, d]) => !d.endsWith('(tests)'));
}

const pageStart: Page = {
  path: '',
  title: 'Getting started',
  description: 'Install UI DNA, register it with Claude Code, Codex or Cursor, and run a first reconstruction.',
  spec: '01',
  source: 'README.md',
  toc: [{ num: '01.1', title: 'Install', id: 'install' }, { num: '01.2', title: 'Register with your agents', id: 'register' }, { num: '01.3', title: 'Check the setup', id: 'check' }, { num: '01.4', title: 'First run', id: 'first-run' }, { num: '01.5', title: 'Teach your agent', id: 'skill' }],
  body: (r) => {
    let b = crumb('Spec 01', 'Getting started');
    b += '<h1 class="d-h1">Getting started</h1><p class="d-lede">Install the CLI, register it with your coding agent and run a first reconstruction.</p>';
    b += '<div class="d-meta"><span class="d-tag">Node 20.19+</span><span class="d-tag">Chromium via Playwright</span><span class="d-tag blue">MCP + CLI</span><span class="d-tag green">No API keys</span></div>';
    b += h2('01.1', 'Install', 'install');
    b += '<p>UI&nbsp;DNA is one npm package with two commands, <code>uidna</code> and <code>uidna-mcp</code>. It drives a local Chromium that Playwright installs.</p>';
    b += r.code('bash', 'npm install -g uidna-mcp\nnpx playwright install chromium');
    b += note('1', 'No global install', 'Every command also runs through npx, for example <code>npx uidna-mcp doctor</code>.');
    b += h2('01.2', 'Register with your agents', 'register');
    b += '<p><code>uidna setup</code> adds the MCP server to Claude Code, Codex and Cursor. It prints the planned changes, asks before writing and backs up every file it touches.</p>';
    b += r.code('bash', 'uidna setup');
    b += r.table(['Option', 'Effect'], options(SETUP_TS, ".command('setup')", ".command('doctor')").map(([f, d]) => [`<code>${esc(f)}</code>`, esc(d)]));
    b += '<h3 class="d-h3">Manual configuration</h3>';
    b += r.code('json', '{\n  "mcpServers": {\n    "uidna": { "type": "stdio", "command": "npx", "args": ["-y", "uidna-mcp@latest", "serve"] }\n  }\n}', 'json · mcp config');
    b += note('2', 'Windows', 'The registered command is wrapped in <code>cmd /c</code>.');
    b += h2('01.3', 'Check the setup', 'check');
    b += '<p>Browser availability, Chrome DevTools reachability and where the server is registered.</p>';
    b += r.code('bash', 'uidna doctor');
    b += h2('01.4', 'First run', 'first-run');
    b += '<p>Without an agent, <code>uidna reconstruct</code> runs the whole loop on one page: scan, explore, tokens, generate, verify and report.</p>';
    b += r.code('bash', 'uidna reconstruct https://example.com ./example-clone --viewports 1280,768,390');
    b += '<h3 class="d-h3">A small site you own</h3><p>Up to five same-origin pages, JSON responses captured as data, forms exercised with synthetic values.</p>';
    b += r.code('bash', "uidna reconstruct http://localhost:3000 ./my-site \\\n  --crawl '{\"maxPages\":5}' --capture-bodies json --policy forms");
    b += note('!', 'Authorized use', `Scan interfaces you own or are allowed to analyze. Every non-GET request is blocked while exploring. <a class="d-a" href="${r.rel('how-it-works/#authorized-use')}">More</a>`, true);
    b += '<h3 class="d-h3">What you get</h3>';
    b += steps([
      ['<code>./.uidna/&lt;scan-id&gt;/</code>', 'Captures, screenshots and the UI DNA document.'],
      ['<code>./example-clone/</code>', 'A React, TypeScript, Tailwind and Vite project, installed and built.'],
      ['The DiffReport', 'One finding per difference, with regressions and resolved findings per attempt.'],
      ['<code>report.html</code>', 'A static report of the evidence, next to the scan.'],
    ]);
    b += h2('01.5', 'Teach your agent', 'skill');
    b += `<p>The shipped skill teaches the agent the loop. Copy <a class="d-a" href="${GH}skills/uidna/SKILL.md"><code>skills/uidna/SKILL.md</code></a> into your agent’s skills directory; for Claude Code that is <code>~/.claude/skills/uidna/</code>. Then ask:</p>`;
    b += r.code('prompt', 'Reconstruct http://localhost:3000 at 1280, 768 and 390 px with UI DNA.\nRepair until no regressions remain.', 'prompt · Claude Code, Codex or Cursor');
    return b;
  },
};

const pageHow: Page = {
  path: 'how-it-works/',
  title: 'How it works',
  description: 'The UI DNA loop, what ships today, authorized use and the limitations.',
  spec: '02',
  source: 'README.md',
  toc: HOW.map(([num, title]) => ({ num, title, id: slug(title) })),
  body: (r) => {
    let b = crumb('Spec 02', 'How it works');
    b += '<h1 class="d-h1">How it works</h1><p class="d-lede">UI&nbsp;DNA measures; your agent decides. Every step leaves evidence, and every value says where it came from.</p>';
    for (const [num, title, readme] of HOW) b += h2(num, title, slug(title)) + r.markdown(section(README, readme), '');
    return b;
  },
};

const pageTools: Page = {
  path: 'tools/',
  title: 'Tools',
  description: 'The twelve UI DNA tools, identical over MCP and the CLI, and the evidence envelope they share.',
  spec: '03',
  source: 'docs/tools.md',
  toc: [{ num: '03.0', title: 'The evidence envelope', id: 'envelope' }, { num: '03.1', title: 'The twelve tools', id: 'index' }, { num: '03.2', title: 'CLI only', id: 'cli-only' }],
  body: (r) => {
    let b = crumb('Spec 03', 'Tools');
    b += '<h1 class="d-h1">Twelve tools</h1><p class="d-lede">The same twelve over MCP and the CLI. Every one answers in the same envelope.</p>';
    b += h2('03.0', 'The evidence envelope', 'envelope');
    b += r.code('json', '{\n  "result": {},\n  "evidence_id": "ev_3f9a1c7b2d4e",\n  "evidence": { "kind": "scan", "inputs": {}, "artifacts": [], "capturedAt": "2026-10-13T17:29:00.000Z" },\n  "limitations": [],\n  "unknowns": []\n}', 'json · evidence envelope');
    const intro = TOOLS_MD.split('```')[2]?.split('\n|')[0] ?? '';
    b += r.markdown(intro, 'docs');
    b += h2('03.1', 'The twelve tools', 'index');
    b += r.table(['Pin', 'Tool', 'Group', 'Shape', 'CLI'], TOOLS.map((t, k) => {
      const g = GROUP[t.name] ?? '';
      return [`<code>${pad2(k + 1)}</code>`, `<a class="d-a" href="${r.rel(`tools/${t.name}/`)}"><code>${t.name}</code></a>`, `<span class="d-tag ${TONE[g] ?? ''}">${g}</span>`, esc(t.shape), `<code>${esc(t.cli)}</code>`];
    }));
    b += h2('03.2', 'CLI only', 'cli-only');
    b += r.table(['Command', 'What it does'], CLI_ONLY.map((c) => [`<a class="d-a" href="${r.rel('cli/#' + c.cmd.split(' ')[1])}"><code>${esc(c.cmd)}</code></a>`, esc(c.what)]));
    return b;
  },
};

function pageTool(t: Tool, k: number): Page {
  const g = GROUP[t.name] ?? '';
  const e = t.effects;
  const destructive = (' ' + e.replace('non-destructive', '')).includes(' destructive');
  const idempotent = !e.includes('not idempotent') && e.includes('idempotent');
  const fx: [string, boolean, string][] = [
    ['Writes artifacts', e.includes('writes artifacts'), e.includes('writes artifacts') ? 'under the scan directory' : 'read-only'],
    ['Destructive', destructive, destructive ? 'overwrites generated files' : 'non-destructive'],
    ['Idempotent', idempotent, idempotent ? 'same input, same output' : 'not idempotent'],
    ['Network', e.includes('reaches the network'), e.includes('reaches the network') ? 'reaches the network' : 'local only'],
    ['Long-running', e.includes('Long-running'), e.includes('Long-running') ? 'progress and cancellation' : 'returns immediately'],
  ];
  const n = pad2(k + 1);
  return {
    path: `tools/${t.name}/`,
    title: t.name,
    description: t.desc.split('. ')[0] + '.',
    spec: `03.${n}`,
    source: 'docs/tools.md',
    toc: [{ num: '.1', title: 'Effects', id: 'effects' }, { num: '.2', title: 'Input', id: 'input' }, { num: '.3', title: 'Result fields', id: 'result' }],
    body: (r) => {
      let b = crumb('Spec 03', 'Tools', `Pin ${n} of ${TOOLS.length}`);
      b += `<div class="d-ds"><div class="pin"><small>Pin</small>${n}</div><div><h1${t.name.length > 16 ? ' class="long"' : ''}>${t.name.replace(/_/g, '_<wbr>')}</h1><p class="d-lab"><b>${esc(t.title)}</b> · shape ${t.shape} · group ${g}</p></div></div>`;
      b += `<div class="d-meta"><span class="d-tag ${TONE[g] ?? ''}">${g}</span><span class="d-tag">${t.shape}</span></div>`;
      b += `<p class="d-desc">${r.inline(t.desc)}</p>`;
      b += `<div class="d-cmd"><span>CLI</span><code>${esc(t.cli)}</code>${copyButton(t.cli)}</div>`;
      b += `<div class="d-cmd"><span>MCP</span><code>${t.name}</code>${copyButton(t.name)}</div>`;
      b += h2(`03.${n}.1`, 'Effects', 'effects');
      b += `<div class="d-fx">${fx.map(([lab, on, sub]) => `<div class="${on ? 'yes' : 'no'}"><b>${lab}</b><span>${sub}</span></div>`).join('')}</div>`;
      b += h2(`03.${n}.2`, 'Input', 'input');
      b += r.table(['Field', 'Type', 'Required', 'Description'], t.inputs.map(([f = '', ty = '', req = '', d = '']) => [
        `<code>${esc(f.replace(/`/g, ''))}</code>`,
        r.inline(ty),
        req === 'yes' ? '<span class="req">required</span>' : '<span class="opt">optional</span>',
        d ? r.inline(d) : '<span class="opt">—</span>',
      ]), 1);
      b += h2(`03.${n}.3`, 'Result fields', 'result');
      b += `<div class="d-chips">${t.results.map((x) => `<code>${esc(x)}</code>`).join('')}</div>`;
      b += `<p>Every field arrives inside the <a class="d-a" href="${r.rel('tools/#envelope')}">evidence envelope</a>.</p>`;
      return b;
    },
    aside: (r) => `<div class="d-pins"><p class="d-lab"><b>Pinout</b> · ${TOOLS.length} tools</p><ol class="d-pinlist">${TOOLS.map((x, i) => `<li><a href="${r.rel(`tools/${x.name}/`)}"${x.name === t.name ? ' class="on" aria-current="page"' : ''}><span>${pad2(i + 1)}</span><em>${x.name}</em></a></li>`).join('')}</ol></div>`,
  };
}

const pageCli: Page = {
  path: 'cli/',
  title: 'CLI',
  description: 'Every uidna command, the global options, setup, doctor, serve and the configuration file.',
  spec: '04',
  source: 'src/cli.ts',
  toc: [{ num: '04.1', title: 'Commands', id: 'commands' }, { num: '04.2', title: 'Global options', id: 'options' }, { num: '04.3', title: 'setup', id: 'setup' }, { num: '04.4', title: 'doctor', id: 'doctor' }, { num: '04.5', title: 'serve', id: 'serve' }, { num: '04.6', title: 'Configuration', id: 'config' }],
  body: (r) => {
    const only = (cmd: string): string => CLI_ONLY.find((c) => c.cmd === `uidna ${cmd}`)?.what ?? '';
    let b = crumb('Spec 04', 'CLI');
    b += '<h1 class="d-h1">The <code>uidna</code> command</h1><p class="d-lede">One command per tool, plus setup, doctor and serve. Add <code>--json</code> to any of them to see the envelope.</p>';
    b += h2('04.1', 'Commands', 'commands');
    let cmds = r.markdown(section(README, 'Tools and commands'), '');
    for (const t of TOOLS) cmds = cmds.split(`<td><code>${t.name}</code></td>`).join(`<td><a class="d-a" href="${r.rel(`tools/${t.name}/`)}"><code>${t.name}</code></a></td>`);
    b += cmds;
    b += h2('04.2', 'Global options', 'options');
    b += r.table(['Option', 'Effect'], options(CLI_TS, '.option(').map(([f, d]) => [`<code>${esc(f)}</code>`, esc(d)]));
    b += h2('04.3', '<code>uidna setup</code>', 'setup') + `<p>${esc(only('setup'))}.</p>` + r.code('bash', 'uidna setup');
    b += r.table(['Option', 'Effect'], options(SETUP_TS, ".command('setup')", ".command('doctor')").map(([f, d]) => [`<code>${esc(f)}</code>`, esc(d)]));
    b += h2('04.4', '<code>uidna doctor</code>', 'doctor') + `<p>${esc(only('doctor'))}.</p>` + r.code('bash', 'uidna doctor');
    b += r.table(['Option', 'Effect'], options(SETUP_TS, ".command('doctor')").map(([f, d]) => [`<code>${esc(f)}</code>`, esc(d)]));
    b += h2('04.5', '<code>uidna serve</code>', 'serve') + `<p>${esc(only('serve'))}.</p>` + r.code('bash', 'npx -y uidna-mcp@latest serve');
    b += h2('04.6', 'Configuration', 'config');
    b += '<p>Optional <code>uidna.config.json</code> in the working directory. Environment variables win over the file.</p>';
    // top-level keys, with the comment above each when the schema has one
    const SAY: Record<string, string> = {
      budget: 'Per-scan budget: <code>timeMs</code>, <code>pages</code>, <code>actions</code>, <code>resources</code> (null for no limit).',
      headless: 'Launch mode for the Playwright browser. Default true.',
      debug: 'Verbose diagnostics on stderr.',
    };
    const keys = [...CONFIG_TS.matchAll(/(?:^ {4}\/\*\* (.+?) \*\/\n)?^ {4}(\w+): z/gm)].map((m) => {
      const key = m[2] ?? '';
      return [`<code>${key}</code>`, SAY[key] ?? (m[1] ? r.inline(m[1]) : '')];
    });
    b += r.table(['Key', 'Meaning'], keys);
    const envs = [...new Set([...CONFIG_TS.matchAll(/\b(UIDNA_[A-Z_]+)\b/g)].map((m) => m[1] ?? ''))];
    b += r.table(['Environment variable'], envs.map((v) => [`<code>${v}</code>`]));
    return b;
  },
};

const pageDocument: Page = {
  path: 'document/',
  title: 'The UI DNA document',
  description: 'The UI DNA document: provenance, shape, states, transitions, components, tokens and every facet added since.',
  spec: '05',
  source: 'docs/ui-dna.md',
  toc: DNA_SECTIONS,
  body: (r) => {
    let b = crumb('Spec 05', 'The document');
    b += '<h1 class="d-h1">The UI&nbsp;DNA document</h1>';
    b += '<p class="d-lede">An interface described the way an engineer needs it to rebuild it: what is on the page, how it is laid out, which values repeat, how it reacts, and what could not be observed.</p>';
    b += '<div class="d-meta"><span class="d-tag blue">Schema 0.3.0</span><span class="d-tag">uidna-schema</span><span class="d-tag">Zod · JSON Schema · TypeScript</span></div>';
    const intro = (DNA_PARTS[0] ?? '').split('\n\n').slice(2).join('\n\n');
    b += r.markdown(intro, 'docs');
    DNA_SECTIONS.forEach((s, i) => {
      const raw = (DNA_PARTS[2 * i + 1] ?? '').trim();
      const since = /\((\d+\.\d+\.\d+)\)/.exec(raw)?.[1];
      b += h2(s.num, s.title, s.id, since ? ` <span class="d-tag blue d-since">since ${since}</span>` : '');
      b += r.markdown(DNA_PARTS[2 * i + 2] ?? '', 'docs');
    });
    for (const [kind, cls] of [['measured', 'k-m'], ['observed', 'k-o'], ['inferred', 'k-i'], ['unknown', 'k-u']] as const) {
      b = b.replace(`<td><code>${kind}</code></td>`, `<td><span class="k ${cls}">${kind}</span></td>`);
    }
    return b;
  },
};

const pageChangelog: Page = {
  path: 'changelog/',
  title: 'Changelog',
  description: 'Every UI DNA release and what changed in it.',
  spec: '06',
  source: 'CHANGELOG.md',
  toc: VERSIONS.map((x) => ({ num: x.v, title: x.date, id: `v${x.v.replace(/\./g, '-')}` })),
  body: (r) => {
    let b = crumb('Spec 06', 'Releases');
    b += '<h1 class="d-h1">Changelog</h1><p class="d-lede">Every release of <code>uidna-mcp</code>. The schema keeps its own changelog in <code>packages/schema</code>.</p>';
    const parts = CHANGELOG.split(/^## \[([\d.]+)\] - (\S+)$/m);
    for (let i = 1; i < parts.length; i += 3) {
      const v = parts[i] ?? '';
      b += h2(v, `Version ${v}`, `v${v.replace(/\./g, '-')}`, ` <span class="d-tag d-since">${parts[i + 1] ?? ''}</span>`);
      b += r.markdown(parts[i + 2] ?? '', '');
    }
    return b;
  },
};

const PAGES: Page[] = [pageStart, pageHow, pageTools, ...TOOLS.map(pageTool), pageCli, pageDocument, pageChangelog];

// ─── the index of specifications ───
interface NavItem { num: string; label: string; href: string; page: string }
const NAV: { num: string; title: string; items: NavItem[] }[] = [
  { num: '01', title: 'Getting started', items: pageStart.toc.map((x) => ({ num: x.num, label: x.title, href: `#${x.id}`, page: '' })) },
  { num: '02', title: 'How it works', items: pageHow.toc.map((x) => ({ num: x.num, label: x.title, href: `#${x.id}`, page: 'how-it-works/' })) },
  { num: '03', title: 'Tools', items: [{ num: '03.00', label: 'Overview and envelope', href: '', page: 'tools/' }, ...TOOLS.map((t, k) => ({ num: `03.${pad2(k + 1)}`, label: `<code>${t.name}</code>`, href: '', page: `tools/${t.name}/` }))] },
  { num: '04', title: 'CLI', items: pageCli.toc.map((x) => ({ num: x.num, label: x.title, href: `#${x.id}`, page: 'cli/' })) },
  { num: '05', title: 'The document', items: DNA_SECTIONS.map((x) => ({ num: x.num, label: x.title, href: `#${x.id}`, page: 'document/' })) },
  { num: '06', title: 'Releases', items: VERSIONS.map((x) => ({ num: x.v, label: x.date, href: `#v${x.v.replace(/\./g, '-')}`, page: 'changelog/' })) },
];

const LOGO = '<svg viewBox="0 0 32 32" aria-hidden="true"><rect x="1" y="1" width="30" height="30" fill="#f1efe8" stroke="#121211"></rect><path d="M11 6.5c0 6 10 4 10 9.5s-10 3.5-10 9.5" fill="none" stroke="#121211" stroke-width="2.2"></path><path d="M21 6.5c0 6-10 4-10 9.5s10 3.5 10 9.5" fill="none" stroke="#2244ff" stroke-width="2.2"></path><path d="M12.4 9.6h7.2M11.4 16h9.2M12.4 22.4h7.2" stroke="#121211" stroke-opacity=".45" stroke-width="1.4"></path></svg>';

function render(page: Page, index: number): string {
  const depth = page.path.split('/').filter(Boolean).length;
  const r = new Renderer(depth);
  const brand = `<a class="d-brand" href="${r.rel('')}">${LOGO}<span><b>UI DNA</b><p class="d-lab">Specifications · rev ${VERSION}</p></span></a>`;
  const groups = NAV.map((g) => {
    const items = g.items.map((it) => {
      const here = it.page === page.path;
      const on = here && (it.href === '' || it.href === `#${page.toc[0]?.id ?? ''}`);
      const href = here && it.href ? it.href : r.rel(it.page) + it.href;
      return `<a class="d-it${on ? ' on' : ''}" href="${href}"${on ? ' aria-current="page"' : ''}><span>${it.num}</span>${it.label}</a>`;
    }).join('');
    return `<div class="d-group"><p class="d-gh"><span>${g.num}</span>${g.title}</p>${items}</div>`;
  }).join('');
  const rail = `<aside class="d-rail" aria-label="Index of specifications">${brand}`
    + '<label class="d-search"><svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.4"></circle><path d="M10.5 10.5l3.5 3.5" stroke="currentColor" stroke-width="1.4"></path></svg><input type="search" placeholder="Search specs" aria-label="Search the specifications" id="d-q"><kbd>/</kbd></label>'
    + `<nav class="d-nav" aria-label="Specifications">${groups}<p class="d-none" hidden>Nothing matches. Try a tool name or a field.</p></nav>`
    + `<div class="d-rail-foot"><a href="${r.rel('../')}">← Set</a><a href="https://github.com/rohzzn/uidna">GitHub</a><a href="https://www.npmjs.com/package/uidna-mcp">npm</a></div></aside>`;
  const toc = `<aside class="d-toc" aria-label="On this sheet"><div><p class="d-lab"><b>On this sheet</b></p><ol class="d-toclist">${page.toc.map((x, k) => `<li><a href="#${x.id}"${k === 0 ? ' class="on"' : ''}><span>${x.num}</span>${x.title}</a></li>`).join('')}</ol></div>`
    + (page.aside ? page.aside(r) : '')
    + `<div class="d-tb"><div>Spec<b>${page.spec}</b></div><div>Rev<b>${VERSION}</b></div><div>Schema<b>0.3.0</b></div><div>Source<b>${posix.basename(page.source)}</b></div><div class="wide"><a href="${GH}${page.source}">Edit on GitHub ↗</a></div></div></aside>`;
  const prev = PAGES[index - 1];
  const next = PAGES[index + 1];
  const pager = '<nav class="d-pager" aria-label="Previous and next">'
    + (prev ? `<a href="${r.rel(prev.path)}"><span class="d-lab">← ${prev.spec}</span><b>${prev.title}</b></a>` : `<a href="${r.rel('../')}"><span class="d-lab">← The set</span><b>Drawing set</b></a>`)
    + (next ? `<a href="${r.rel(next.path)}"><span class="d-lab">${next.spec} →</span><b>${next.title}</b></a>` : `<a href="${r.rel('')}"><span class="d-lab">01 →</span><b>Getting started</b></a>`)
    + '</nav>';
  const rx = Array.from({ length: 20 }, (_v, i) => `<span style="left: ${i * 100}px">${i * 100}</span>`).join('');
  const ry = Array.from({ length: 120 }, (_v, i) => `<span style="top: ${(i + 1) * 100}px">${(i + 1) * 100}</span>`).join('');
  const sheet = `<article class="d-sheet">${page.body(r)}${pager}</article>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<!-- Generated by scripts/site-docs.ts. Do not edit by hand. -->
<title>${esc(page.title)} · UI DNA docs</title>
<meta name="description" content="${attr(page.description)}">
<meta name="theme-color" content="#f1efe8">
<link rel="canonical" href="${SITE}${page.path}">
<meta property="og:type" content="website">
<meta property="og:title" content="${attr(page.title)} · UI DNA docs">
<meta property="og:description" content="${attr(page.description)}">
<meta property="og:url" content="${SITE}${page.path}">
<link rel="icon" href="${r.rel('../favicon.svg')}" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${FONTS}">
<link rel="stylesheet" href="${r.rel('docs.css')}">
</head>
<body style="margin: 0">
<div class="docs">
<a class="d-corner" href="#top" aria-label="Top of the page">${LOGO}</a><div class="d-rx" aria-hidden="true">${rx}</div><div class="d-ry" aria-hidden="true">${ry}</div>
<div class="d-mbar">${brand}<button type="button" id="d-menu" aria-expanded="false">Index</button></div>
<div class="d-shell" id="top">${rail}<main class="d-main">${sheet}</main>${toc}</div>
</div>
<script src="${r.rel('docs.js')}"></script>
</body>
</html>
`;
}

async function main(): Promise<void> {
  const check = process.argv.includes('--check');
  const files = PAGES.map((p, i) => ({ path: join(outRoot, p.path, 'index.html'), text: render(p, i) }));
  if (check) {
    const stale: string[] = [];
    for (const f of files) {
      const current = await readFile(f.path, 'utf8').catch(() => '');
      if (current !== f.text) stale.push(f.path);
    }
    if (stale.length) {
      console.error(`website/docs is stale (${stale.length} pages); run npm run docs:site`);
      process.exit(1);
    }
    console.log(`website/docs is up to date (${files.length} pages)`);
    return;
  }
  for (const dir of GENERATED_DIRS) await rm(join(outRoot, dir), { recursive: true, force: true });
  for (const f of files) {
    await mkdir(dirname(f.path), { recursive: true });
    await writeFile(f.path, f.text, 'utf8');
  }
  console.log(`wrote ${files.length} pages to website/docs`);
}

await main();
