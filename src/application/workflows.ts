/**
 * Registers the browser-driven workflows (scan, explore, generate, verify,
 * report, reconstruct) in the handler registry.
 */
import * as contracts from '../contracts/tools.js';
import { exploreInteractions } from './explore-workflow.js';
import { generateProject } from './generate-workflow.js';
import { bind, type AnyHandler } from './handlers.js';
import { reconstructInterface } from './reconstruct.js';
import { scanInterface } from './scan.js';
import { reportReconstruction, verifyReconstruction } from './verify-workflow.js';

/** Handlers for the browser-driven workflows. */
export function registerWorkflowHandlers(): [string, AnyHandler][] {
  return [
    bind(contracts.scanInterface, scanInterface),
    bind(contracts.exploreInteractions, exploreInteractions),
    bind(contracts.generateProject, generateProject),
    bind(contracts.verifyReconstruction, verifyReconstruction),
    bind(contracts.reportReconstruction, reportReconstruction),
    bind(contracts.reconstructInterface, reconstructInterface),
  ];
}
