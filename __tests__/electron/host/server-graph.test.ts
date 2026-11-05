import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { createHeadlessElectron, type HeadlessElectron } from '../../../electron/host/headless-electron';

/**
 * What a Tars server's code asks of `electron`, read from the source with the
 * TypeScript parser, against what the headless electron answers.
 *
 * The walk starts at CORE_ROOTS and follows value imports (never
 * `import type`) through relative specifiers. In every file it reaches, each
 * `<name>.<member>` and `new <name>` on a value import of `electron` must be a
 * member the headless electron answers. The window files are reached through
 * one edge each and the server never calls their functions: there, members of
 * objects the server has none of (Menu, protocol, shell...) are allowed, and
 * fail by name if a server ever calls them.
 *
 * How it fails:
 * - a member the core uses is missing from headless-electron.ts (a server
 *   would throw `undefined is not a function` where the desktop works)
 * - a dialog, shell, Menu, protocol, Tray, screen or clipboard call, or a
 *   `new BrowserWindow`, outside the window files
 * - an `electron` member used at module scope, which a server would reach
 *   at load, before anything could stop it
 * - a `require('electron')` or `import('electron')` the walk cannot read
 * - the walk itself missing what it should find: the last case removes
 *   `app.getAppPath` from a headless electron and expects it named, with
 *   the chain of imports that reaches it
 */

const ROOT = path.resolve(__dirname, '../../..');

const CORE_ROOTS = [
  'electron/services/api-server.ts',
  'electron/core/agent-manager.ts',
  'electron/core/pty-manager.ts',
  'electron/services/telegram-bot.ts',
  'electron/services/mcp-orchestrator.ts',
  'electron/services/hooks-manager.ts',
];

/** Reached through one edge each; their functions run only with a window. */
const WINDOW_FILES = new Set([
  'electron/core/window-manager.ts',
  'electron/core/edit-context-menu.ts',
  'electron/handlers/chat-handlers.ts',
]);

const UNAVAILABLE = new Set([
  'dialog', 'shell', 'Menu', 'MenuItem', 'Tray', 'protocol', 'screen',
  'clipboard', 'nativeImage', 'powerSaveBlocker', 'safeStorage',
]);

interface Use { file: string; line: number; what: string; object: string; member: string | null; atLoad: boolean }

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');

function resolveRelative(from: string, spec: string): string | null {
  const base = path.resolve(path.dirname(from), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts'), base]) {
    if (candidate.endsWith('.ts') && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function unwrap(node: ts.Expression): ts.Expression {
  let current = node;
  while (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isNonNullExpression(current)) {
    current = current.expression;
  }
  return current;
}

function insideFunction(node: ts.Node): boolean {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return true;
  }
  return false;
}

function scan(): { uses: Use[]; dynamic: string[]; chains: Map<string, string[]> } {
  const uses: Use[] = [];
  const dynamic: string[] = [];
  const parentOf = new Map<string, string | null>();
  const queue = CORE_ROOTS.map(r => path.join(ROOT, r));
  for (const r of queue) parentOf.set(r, null);

  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf-8'), ts.ScriptTarget.Latest, true);
    const electronNames = new Set<string>();

    for (const statement of source.statements) {
      if ((ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const spec = statement.moduleSpecifier.text;
        const typeOnly = ts.isImportDeclaration(statement) ? statement.importClause?.isTypeOnly === true : statement.isTypeOnly;
        if (typeOnly) continue;
        if (spec === 'electron' && ts.isImportDeclaration(statement)) {
          const bindings = statement.importClause?.namedBindings;
          if (bindings && ts.isNamedImports(bindings)) {
            for (const element of bindings.elements) if (!element.isTypeOnly) electronNames.add(element.name.text);
          } else if (bindings || statement.importClause?.name) {
            dynamic.push(`${rel(file)}: a default or namespace import of electron`);
          }
        } else if (spec.startsWith('.')) {
          const next = resolveRelative(file, spec);
          if (next && !parentOf.has(next)) { parentOf.set(next, file); queue.push(next); }
        }
      }
    }

    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])) {
        const spec = node.arguments[0].text;
        const callee = node.expression;
        const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
        const isImport = callee.kind === ts.SyntaxKind.ImportKeyword;
        if ((isRequire || isImport) && spec === 'electron') dynamic.push(`${rel(file)}: ${isRequire ? 'require' : 'import'}('electron')`);
        if ((isRequire || isImport) && spec.startsWith('.')) {
          const next = resolveRelative(file, spec);
          if (next && !parentOf.has(next)) { parentOf.set(next, file); queue.push(next); }
        }
      }
      if (ts.isPropertyAccessExpression(node)) {
        const target = unwrap(node.expression);
        if (ts.isIdentifier(target) && electronNames.has(target.text)) {
          uses.push({ file: rel(file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, what: `${target.text}.${node.name.text}`, object: target.text, member: node.name.text, atLoad: !insideFunction(node) });
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && electronNames.has(node.expression.text)) {
        uses.push({ file: rel(file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, what: `new ${node.expression.text}`, object: node.expression.text, member: null, atLoad: !insideFunction(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const chains = new Map<string, string[]>();
  for (const file of parentOf.keys()) {
    const chain: string[] = [];
    for (let at: string | null = file; at; at = parentOf.get(at) ?? null) chain.unshift(rel(at));
    chains.set(rel(file), chain);
  }
  return { uses, dynamic, chains };
}

function unanswered(electron: HeadlessElectron, uses: Use[]): Use[] {
  const objects = electron as unknown as Record<string, object>;
  return uses.filter(use => {
    if (WINDOW_FILES.has(use.file)) return false;
    if (UNAVAILABLE.has(use.object)) return true;
    if (use.member === null) return use.object === 'BrowserWindow' || !(use.object in objects);
    const object = objects[use.object];
    return object === undefined || !(use.member in object);
  });
}

function headless(): HeadlessElectron {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-root-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ version: '0.0.0' }));
  return createHeadlessElectron({ root: dir, dev: false, log: () => {}, exit: () => {} });
}

const { uses, dynamic, chains } = scan();
const describeUse = (use: Use) => `${use.what} at ${use.file}:${use.line}, reached by ${chains.get(use.file)?.join(' -> ')}`;

describe("a Tars server's electron", () => {
  it('reaches the core it was measured on', () => {
    expect(chains.size).toBeGreaterThan(200);
    // Measured on dc623b59: 228 modules, 15 importing electron by value, 11 using its members.
    expect(new Set(uses.map(u => u.file)).size).toBeGreaterThanOrEqual(10);
  });

  it('answers every member the core uses', () => {
    expect(unanswered(headless(), uses).map(describeUse)).toEqual([]);
  });

  it('is asked nothing at module load', () => {
    expect(uses.filter(u => u.atLoad).map(describeUse)).toEqual([]);
  });

  it('is never required in a way the walk cannot read', () => {
    expect(dynamic).toEqual([]);
  });

  it('names a member it lacks, with the chain that reaches it', () => {
    const electron = headless();
    delete (electron.app as Partial<typeof electron.app>).getAppPath;
    const missing = unanswered(electron, uses).map(describeUse);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every(line => line.startsWith('app.getAppPath at '))).toBe(true);
    expect(missing.some(line => line.includes('electron/utils/hooks-path.ts') && line.includes(' -> '))).toBe(true);
  });
});
