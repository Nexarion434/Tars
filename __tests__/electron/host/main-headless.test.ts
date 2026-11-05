import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import { isHeadless } from '../../../electron/host/headless';

/**
 * main.ts is the one boot of the desktop and of a Tars server. On a server
 * (plain Node, its `electron` the headless one) it skips the steps the headless
 * electron refuses, each where it stands, so every other step keeps the
 * desktop's order by construction (docs/superpowers/plans/2026-11-02-tars-cloud.md,
 * Task 3).
 *
 * How it fails:
 * - a window step reached unguarded at boot: a server throws there
 * - a core step put under the guard: a server silently goes without it
 * - isHeadless() true in Electron, or in a test that mocks electron without
 *   the headless marker (three suites import main.ts that way and must keep
 *   the desktop's path), or false on a server
 */

const MAIN = path.resolve(__dirname, '../../../electron/main.ts');

/** What the headless electron refuses, as main.ts calls it at boot. */
const WINDOW_STEPS = [
  'registerProtocolSchemes',
  'setupProtocolHandler',
  'createWindow',
  'uncaught.windowOpened',
  'installDesktopShell',
  'initTray',
  'dialog.showMessageBox',
  'initAutoUpdater',
  'setMainWindowGetter',
  'checkForUpdates',
];

/** Reached only by 'activate' and a second launch, which a server never sees. */
const WINDOW_ONLY_FUNCTIONS = new Set(['remakeMainWindow', 'showMainWindow']);

/** What keeps agents alive and reachable: never skipped. */
const CORE_STEPS = [
  'loadAgents', 'startAgentAutosave', 'registerIpcHandlers', 'initVaultDb', 'startHermesRelay',
  'initTelegramBot', 'initApiServer', 'startRestartRecovery', 'startAgentWatch', 'startTaskWatch',
  'setupMcpOrchestrator', 'configureStatusHooks', 'startCliUpdates', 'runShutdownSteps',
];

interface Call { name: string; line: number; guarded: boolean; inWindowOnlyFunction: boolean }

function calleeName(expression: ts.Expression): string | null {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
    return `${expression.expression.text}.${expression.name.text}`;
  }
  return null;
}

function isNotHeadless(condition: ts.Expression): boolean {
  return ts.isPrefixUnaryExpression(condition)
    && condition.operator === ts.SyntaxKind.ExclamationToken
    && ts.isIdentifier(condition.operand)
    && condition.operand.text === 'HEADLESS';
}

function callsOf(source: ts.SourceFile): Call[] {
  const calls: Call[] = [];
  const visit = (node: ts.Node, guarded: boolean, inWindowOnlyFunction: boolean) => {
    const nowGuarded = guarded;
    let nowWindowOnly = inWindowOnlyFunction;
    if (ts.isFunctionDeclaration(node) && node.name && WINDOW_ONLY_FUNCTIONS.has(node.name.text)) nowWindowOnly = true;
    if (ts.isIfStatement(node) && isNotHeadless(node.expression)) {
      visit(node.expression, guarded, nowWindowOnly);
      visit(node.thenStatement, true, nowWindowOnly);
      if (node.elseStatement) visit(node.elseStatement, guarded, nowWindowOnly);
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      if (name) calls.push({ name, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, guarded: nowGuarded, inWindowOnlyFunction: nowWindowOnly });
    }
    ts.forEachChild(node, child => visit(child, nowGuarded, nowWindowOnly));
  };
  visit(source, false, false);
  return calls;
}

const source = ts.createSourceFile(MAIN, fs.readFileSync(MAIN, 'utf-8'), ts.ScriptTarget.Latest, true);
const calls = callsOf(source);

describe('main.ts on a server', () => {
  it('finds every window step it guards', () => {
    for (const step of WINDOW_STEPS) expect(calls.some(c => c.name === step), step).toBe(true);
  });

  it('skips each window step, where it stands', () => {
    const unguarded = calls
      .filter(c => WINDOW_STEPS.includes(c.name) && !c.guarded && !c.inWindowOnlyFunction)
      .map(c => `${c.name} at main.ts:${c.line}`);
    expect(unguarded).toEqual([]);
  });

  it('never skips a core step', () => {
    for (const step of CORE_STEPS) expect(calls.some(c => c.name === step), step).toBe(true);
    const skipped = calls.filter(c => CORE_STEPS.includes(c.name) && c.guarded).map(c => `${c.name} at main.ts:${c.line}`);
    expect(skipped).toEqual([]);
  });
});

describe('isHeadless', () => {
  const headlessApp = { headless: true };
  it('is true on plain Node with the headless electron', () => {
    expect(isHeadless({}, headlessApp)).toBe(true);
  });
  it('is false in Electron, whatever its app says', () => {
    expect(isHeadless({ electron: '44.9.3' }, headlessApp)).toBe(false);
  });
  it('is false on plain Node with any other electron (a test mocking it)', () => {
    expect(isHeadless({}, { getAppPath: () => '/' })).toBe(false);
    expect(isHeadless({}, undefined)).toBe(false);
  });
});
