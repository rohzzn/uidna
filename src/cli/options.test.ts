import { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { TOOL_CATALOG } from '../contracts/catalog.js';
import { annotateDna, scanInterface, verifyReconstruction } from '../contracts/tools.js';
import { applyContract, coerce, collectInput, describeFields, kebab } from './options.js';

describe('cli options', () => {
  it('describes every field of every contract with a known kind', () => {
    for (const contract of TOOL_CATALOG) {
      const fields = describeFields(contract);
      expect(fields.length).toBeGreaterThan(0);
      for (const field of fields) {
        expect(['string', 'number', 'boolean', 'array', 'object'], `${contract.name}.${field.name}`).toContain(field.kind);
      }
      for (const positional of contract.cli.positionals) {
        if (positional === 'patchesFile') continue;
        expect(fields.map((f) => f.name), `${contract.name} positional ${positional}`).toContain(positional);
      }
    }
  });

  it('derives kinds, optionality and item kinds', () => {
    const fields = describeFields(scanInterface);
    const viewports = fields.find((f) => f.name === 'viewports');
    expect(viewports?.kind).toBe('array');
    expect(viewports?.itemKind).toBe('number');
    expect(viewports?.optional).toBe(true);
    expect(fields.find((f) => f.name === 'headless')?.kind).toBe('boolean');
    expect(fields.find((f) => f.name === 'budget')?.kind).toBe('object');
    expect(describeFields(verifyReconstruction).find((f) => f.name === 'outDir')?.optional).toBe(false);
    expect(describeFields(annotateDna).find((f) => f.name === 'patches')?.kind).toBe('array');
  });

  it('coerces strings into typed values', () => {
    const fields = describeFields(scanInterface);
    const viewports = fields.find((f) => f.name === 'viewports');
    const headless = fields.find((f) => f.name === 'headless');
    const budget = fields.find((f) => f.name === 'budget');
    if (!viewports || !headless || !budget) throw new Error('fields missing');
    expect(coerce(viewports, '1280, 768,390')).toEqual([1280, 768, 390]);
    expect(coerce(viewports, '[390]')).toEqual([390]);
    expect(() => coerce(viewports, 'a,b')).toThrow(/numbers/);
    expect(coerce(headless, true)).toBe(true);
    expect(coerce(headless, 'false')).toBe(false);
    expect(coerce(budget, '{"timeMs": 1000}')).toEqual({ timeMs: 1000 });
    expect(() => coerce(budget, 'nope')).toThrow(/JSON/);
    expect(kebab('cdpEndpoint')).toBe('cdp-endpoint');
  });

  it('registers positionals and options on a commander command and collects input', () => {
    const command = new Command('scan');
    const fields = applyContract(command, scanInterface);
    const flags = command.options.map((o) => o.long);
    expect(flags).toContain('--viewports');
    expect(flags).toContain('--cdp-endpoint');
    expect(flags).toContain('--headless');
    expect(flags).toContain('--no-headless');
    expect(command.registeredArguments.map((a) => a.name())).toEqual(['url']);
    const input = collectInput(scanInterface, fields, ['http://127.0.0.1:1/'], { viewports: '390', headless: false, budget: '{"actions":3}' });
    expect(input).toEqual({ url: 'http://127.0.0.1:1/', viewports: [390], headless: false, budget: { actions: 3 } });
    expect(scanInterface.input.safeParse(input).success).toBe(true);
  });
});
