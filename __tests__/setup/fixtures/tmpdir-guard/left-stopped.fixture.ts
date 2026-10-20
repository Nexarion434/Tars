import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// What a delegated run's stop leaves when the worker ends between its SIGSTOP and its SIGCONT: a process started from
// the file's folder, in a group of its own, stopped. Its script goes with the folder; the process does not.
it.skipIf(process.platform === 'win32')('leaves a stopped process started from its folder', async () => {
  const script = path.join(os.tmpdir(), 'left-stopped-agent.js');
  fs.writeFileSync(script, "process.stdout.write('ready');\nsetInterval(() => {}, 1000);\n");
  const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
  await new Promise(resolve => child.stdout!.once('data', resolve));
  child.stdout!.destroy();
  child.unref();
  process.kill(child.pid!, 'SIGSTOP');
  expect(child.pid).toBeGreaterThan(0);
});
