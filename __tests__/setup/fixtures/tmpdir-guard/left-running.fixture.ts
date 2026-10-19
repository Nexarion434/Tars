import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// A process started from the file's folder that nothing ends, and that has no stdin to read the end of.
it('leaves a running process started from its folder', async () => {
  const script = path.join(os.tmpdir(), 'left-running-agent.js');
  fs.writeFileSync(script, "process.stdout.write('ready');\nsetInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32' });
  await new Promise(resolve => child.stdout!.once('data', resolve));
  child.stdout!.destroy();
  child.unref();
  expect(child.pid).toBeGreaterThan(0);
});
