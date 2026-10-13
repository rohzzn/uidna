/**
 * The MCP adapter end to end: spawn `uidna serve` over stdio, list tools,
 * call a read-only tool against a prepared scan, and check the envelope and
 * the error path.
 */
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ScanStore } from '../src/application/scan-store.js';
import { sampleDocument, sampleScanRecord, SAMPLE_SCAN_ID } from '../src/application/testing.js';
import { TOOL_CATALOG } from '../src/contracts/catalog.js';
import { REPO_ROOT, tempDir } from './helpers.js';

describe('MCP server over stdio', () => {
  let client: Client;
  let transport: StdioClientTransport;
  let outRoot: string;

  beforeAll(async () => {
    outRoot = await tempDir('mcp-scans');
    const store = new ScanStore(outRoot);
    const created = await store.createScan(sampleScanRecord());
    if (!created.ok) throw new Error(created.error.message);
    const saved = await store.saveDna(SAMPLE_SCAN_ID, sampleDocument());
    if (!saved.ok) throw new Error(saved.error.message);

    transport = new StdioClientTransport({
      command: process.execPath,
      args: [join(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(REPO_ROOT, 'src', 'cli.ts'), '--out-root', outRoot, 'serve'],
      cwd: REPO_ROOT,
      stderr: 'pipe',
    });
    client = new Client({ name: 'uidna-e2e', version: '0.0.0' });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close();
  });

  it('advertises every implemented tool with annotations', async () => {
    const listed = await client.listTools();
    const names = listed.tools.map((t) => t.name);
    for (const contract of TOOL_CATALOG) expect(names, `missing ${contract.name}`).toContain(contract.name);
    const inspect = listed.tools.find((t) => t.name === 'inspect_dna');
    expect(inspect?.annotations?.readOnlyHint).toBe(true);
    expect(inspect?.inputSchema).toBeTruthy();
    const scan = listed.tools.find((t) => t.name === 'scan_interface');
    expect(scan?.annotations?.openWorldHint).toBe(true);
    expect(scan?.annotations?.readOnlyHint).toBe(false);
  });

  it('returns the evidence envelope as structured content', async () => {
    const result = await client.callTool({ name: 'inspect_dna', arguments: { scanId: SAMPLE_SCAN_ID } });
    expect(result.isError).toBeFalsy();
    const envelope = result.structuredContent as { result: { summary: { states: number } }; evidence_id: string; limitations: string[]; unknowns: string[] };
    expect(envelope.result.summary.states).toBe(3);
    expect(envelope.evidence_id).toMatch(/^ev_[0-9a-f]{12}$/);
    expect(Array.isArray(envelope.limitations)).toBe(true);
    expect(Array.isArray(envelope.unknowns)).toBe(true);
    const text = (result.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
    expect(JSON.parse(text).evidence_id).toBe(envelope.evidence_id);
  });

  it('reports invalid input and missing scans as errors, not crashes', async () => {
    const invalid = await client.callTool({ name: 'inspect_dna', arguments: { scanId: 'nope' } });
    expect(invalid.isError).toBe(true);
    const missing = await client.callTool({ name: 'inspect_dna', arguments: { scanId: 'scan_20200101_000000' } });
    expect(missing.isError).toBe(true);
    const text = (missing.content as { type: string; text?: string }[]).find((c) => c.type === 'text')?.text ?? '';
    expect(JSON.parse(text).error.tag).toBe('not-found');
    const still = await client.callTool({ name: 'extract_tokens', arguments: { scanId: SAMPLE_SCAN_ID } });
    expect(still.isError).toBeFalsy();
  });
});
