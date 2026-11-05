import { addKnownHost, gitKey, type GitAccessDeps } from '../services/cloud/git-access';

/**
 * tars-server git key | known-host add (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Tasks 2b and 5), for the operator, over SSH or on the server itself.
 *
 * `key` prints the server's public Git key and its fingerprint, making the
 * key on first need (git-access.ts): what the user adds to GitHub, as a
 * repository's deploy key or to the account. `known-host add` reads one
 * `<host> <type> <key>` line from stdin, never from the command line, adds
 * it to the server's own known hosts and prints its fingerprint, to compare
 * with the one the host publishes.
 *
 * One JSON line on `out`; errors on stderr. Exit codes: 0 done, 1 refused,
 * 2 usage.
 */
export async function runGitCommand(args: string[], stdin: string, deps: GitAccessDeps, out: (line: string) => void): Promise<number> {
  const [verb, sub, ...rest] = args;
  if (verb === 'key') {
    const key = await gitKey(deps);
    if (!key.ok) { process.stderr.write(`${key.error}\n`); return 1; }
    out(JSON.stringify({ publicKey: key.publicKey, fingerprint: key.fingerprint }));
    return 0;
  }
  if (verb === 'known-host' && sub === 'add') {
    if (rest.some(a => !a.startsWith('--'))) {
      process.stderr.write('The line goes on stdin: tars-server git known-host add --json < line\n');
      return 1;
    }
    const line = stdin.trim();
    const added = addKnownHost(line, deps);
    if (!added.ok) { process.stderr.write(`${added.error}\n`); return 1; }
    out(JSON.stringify({ host: line.split(/\s+/)[0], fingerprint: added.fingerprint }));
    return 0;
  }
  process.stderr.write('usage: tars-server git key --json | git known-host add --json < line\n');
  return 2;
}
