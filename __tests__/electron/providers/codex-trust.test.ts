import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * A codex agent's folder is trusted before its codex starts (2.0.4), as Claude Code's is (ensureProjectTrusted).
 *
 * Measured on codex-cli 0.163.0: started in a folder its config does not trust, codex first asks "Trust this
 * folder? Codex can read, edit, and run files here, subject to your permission settings", writes no session, and
 * does nothing until someone answers. Nobody does in an agent's terminal: a new codex agent in a new project never
 * started. With `[projects."<folder>"] trust_level = "trusted"` in its config.toml, the same launch ran its turn in
 * 5 s. codex records the folder by its real path (session_meta's cwd).
 *
 * The ways it fails:
 * 1. The folder not trusted, or trusted under another spelling of its path than the one codex reads (/tmp, not
 *    /private/tmp, on macOS): the question again.
 * 2. A choice the user made overwritten: a folder they marked untrusted, or trusted already, written again.
 * 3. A folder that would trust every folder below it (the home folder, /), as ensureProjectTrusted refuses.
 * 4. The rest of config.toml lost, or the file left one codex cannot read: codex then refuses to start at all.
 * 5. The table written again at every launch, until the file is full of copies.
 */

import { ensureCodexProjectTrusted } from '../../../electron/providers/codex-cli';

let codexHome: string;
let project: string;
const config = () => fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf8');
const codexOnPath = (() => { try { return execFileSync('which', ['codex'], { encoding: 'utf8' }).trim(); } catch { return ''; } })();

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-trust-'));
  codexHome = path.join(root, '.codex');
  project = path.join(root, 'projects', 'demo');
  fs.mkdirSync(project, { recursive: true });
});

describe("a codex agent's folder", () => {
  it('is trusted under its real path, the rest of the config kept', () => {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), 'model = "gpt-6-luna"\n\n[mcp_servers.x]\ncommand = "node"\n');
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('written');
    const text = config();
    expect(text).toContain('model = "gpt-6-luna"');
    expect(text).toContain('[mcp_servers.x]');
    expect(text).toContain(`[projects.${JSON.stringify(fs.realpathSync(project))}]\ntrust_level = "trusted"`);
  });

  it('is written once, and a choice already made is left as it is', () => {
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('written');
    expect(ensureCodexProjectTrusted(project, codexHome)).toBe('already');
    expect(config().match(/\[projects\./g)).toHaveLength(1);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'tars-codex-untrusted-'));
    fs.appendFileSync(path.join(codexHome, 'config.toml'), `\n[projects.${JSON.stringify(fs.realpathSync(other))}]\ntrust_level = "untrusted"\n`);
    expect(ensureCodexProjectTrusted(other, codexHome)).toBe('already');
    expect(config()).toContain('trust_level = "untrusted"');
  });

  it('is never the home folder, nor /', () => {
    expect(ensureCodexProjectTrusted(os.homedir(), codexHome)).toBe('refused');
    expect(ensureCodexProjectTrusted('/', codexHome)).toBe('refused');
    expect(fs.existsSync(path.join(codexHome, 'config.toml'))).toBe(false);
  });

  it.skipIf(!codexOnPath)("leaves a config codex's own parser reads", () => {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, 'config.toml'), '[mcp_servers.probe]\ncommand = "node"\nargs = ["/x.js"]\n');
    const odd = path.join(path.dirname(project), 'a "quoted" folder');
    fs.mkdirSync(odd);
    ensureCodexProjectTrusted(project, codexHome);
    ensureCodexProjectTrusted(odd, codexHome);
    const listed = JSON.parse(execFileSync(codexOnPath, ['mcp', 'list', '--json'], {
      encoding: 'utf8', env: { PATH: process.env.PATH, HOME: path.dirname(codexHome), CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'],
    })) as Array<{ name: string }>;
    expect(listed.map(s => s.name)).toEqual(['probe']);
  });
});
