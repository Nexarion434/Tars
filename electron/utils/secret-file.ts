import * as fs from 'fs';
import * as path from 'path';
import { renameReplacingSync } from '../platform/rename-replacing';
import { restrictToOwnerSync, restrictDirToOwnerSync } from '../platform/owner-only';

/**
 * Writing a file that holds credentials.
 *
 * `fs.writeFileSync(p, data)` creates the file with 0666 & ~umask, which on a
 * default umask of 022 lands at 0644 - readable by every other account on the
 * machine. `api-token` and `hermes-webhook-secret` were hardened for this
 * reason; `app-settings.json` was not, and it holds far more: the Telegram,
 * Slack, Discord, Jira, SocialData, X, OpenRouter, DeepSeek, Mimo, Moonshot, Qwen,
 * Zhipu, MiniMax, NVIDIA and Nous Portal keys, the Hermes gateway token, and
 * the gbrain and Honcho credentials. One file, twenty-odd secrets, world
 * readable.
 *
 * `mode` on writeFileSync only applies when the file is CREATED, so an
 * existing 0644 file keeps its mode forever. The explicit chmod is what fixes
 * installs that already have one.
 *
 * The write is atomic as well: a crash between truncate and write used to
 * leave an empty settings file, and the app would silently fall back to
 * defaults - every key gone.
 *
 * A directory this has to create is made 0700, readable by its owner alone.
 * It is how `~/.tars-private` comes into being on an install that never had
 * anything to migrate there: made with the default mode, it was 0755, open to
 * a listing by every account on the machine, while the migration, the only
 * other place that made it, made it 0700. A directory that already exists is
 * left as it is: `~/.dorothy` is the agents' directory, and not this
 * function's to narrow.
 *
 * On Windows the modes do nothing, so the temp file is closed to every account
 * but the user and SYSTEM before it is renamed over the live one
 * (platform/owner-only.ts): the file is never in place with the secret in it
 * and its folder's access list. A failure there is logged and the write goes
 * on. darwin/linux: nothing runs.
 */
export function writeSecretFileSync(filePath: string, contents: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  writeAtomicSync(filePath, contents, 0o600, (tmp) => { restrictToOwnerSync(tmp); });

  // renameSync preserves the temp file's mode, but be explicit: if the target
  // already existed at 0644 on some platform, this is what narrows it.
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // A filesystem without POSIX modes (a network share) - nothing to do.
  }
}

/**
 * An ordinary state file, written atomically.
 *
 * Same temp-file-then-rename as above, without narrowing the mode: the caller's
 * data is not a credential, but a crash between truncate and write would still
 * leave a half-file that the next parse rejects. agents.json already had this
 * treatment; projects.json did not, and losing it silently empties the user's
 * project list.
 *
 * The temp name is fixed, so it is created, never opened. Whatever holds that
 * name is removed first, which takes a link away without touching what it
 * points at, and the file is then made with 'wx', O_CREAT with O_EXCL, which
 * fails rather than follow anything put there in between, a symbolic link or a
 * hard one. Opened the ordinary way, a symbolic link planted at the temp name
 * sent the contents into the file it named, and a hard link truncated that
 * file in place; the rename then made the link the secret file itself. Found
 * by the audit of lot 4. A leftover temp file from a write that died goes the
 * same way; it used to be written over.
 *
 * On Windows the rename fails while another program holds the file open, even
 * to read it; it is retried for about a second (platform/rename-replacing.ts).
 *
 * `beforeRename` gets the written temp file, for what must hold before it
 * takes the live file's place (writeSecretFileSync's access list).
 */
export function writeAtomicSync(filePath: string, contents: string, mode?: number, beforeRename?: (tmp: string) => void): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.rmSync(tmp, { force: true });
  fs.writeFileSync(tmp, contents, { flag: 'wx', mode: mode ?? 0o666 });
  beforeRename?.(tmp);
  renameReplacingSync(tmp, filePath);
}

/**
 * A secret written in place, as api-token is: `fs.writeFileSync` at 0600,
 * exactly as before on darwin/linux, then on Windows closed to every account
 * but the user and SYSTEM (platform/owner-only.ts). Not atomic, so the list
 * lands just after the contents: for that moment the file has what ~/.dorothy
 * hands down, which on a default profile is the user, SYSTEM and the
 * Administrators group.
 */
export function writeSecretFileInPlaceSync(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { mode: 0o600 });
  restrictToOwnerSync(filePath);
}

/**
 * At startup, on Windows: close the secret files that already exist, and the
 * private directory with everything in it, to every account but the user and
 * SYSTEM. An install made before this, a file an older build or another tool
 * left open, a conversation file renamed out of ~/.dorothy with that folder's
 * list: all of them end as a fresh write would leave them. The files' own
 * explicit entries go too. A file or directory that does not exist is
 * skipped quietly. darwin/linux: nothing runs, the modes do this there
 * (ensureSecretFileMode, narrowDataDir).
 *
 * Once, at startup, and not on each read as ensureSecretFileMode is: it starts
 * two icacls per file, and readHermesConnection runs on every gateway call.
 */
export function closeSecretsToOtherAccounts(files: string[], privateDir: string): void {
  for (const file of files) {
    if (fs.existsSync(file)) restrictToOwnerSync(file, { replaceExplicit: true });
  }
  restrictDirToOwnerSync(privateDir);
}

/**
 * Describe a failure to read one of these files, without quoting the file.
 *
 * `console.error('...', err)` on a credential file logs the file back out.
 * Node builds a JSON.parse message out of the input: corruption at the start
 * of hermes-session.json produced `Unexpected token 'e', "es_session"... is
 * not valid JSON`, which is a cookie name in a log that is not 0600 while the
 * file is. The fragment is ten characters and usually harmless, but the rule
 * that no secret reaches a log is only worth having if it holds when the leak
 * is small.
 *
 * redactSecrets is the wrong tool: it matches secret SHAPES (sk-ant-, bearer,
 * NAME=value), and an arbitrary ten-character slice of a file matches none of
 * them, so it would pass `es_session` through and look like it had worked.
 *
 * What a reader needs is why the file was unusable, not what was in it: the
 * parser rejected it, or the filesystem did and here is its code.
 */
export function describeSecretFileError(err: unknown): string {
  if (err instanceof SyntaxError) return 'not valid JSON';
  if (err && typeof err === 'object' && 'code' in err) {
    return String((err as { code: unknown }).code);
  }
  if (err instanceof Error) return err.name;
  return 'unknown error';
}

/**
 * Narrow an existing file to 0600 if it is wider. Called at startup for the
 * files that predate this helper.
 */
export function ensureSecretFileMode(filePath: string): void {
  try {
    const stat = fs.statSync(filePath);
    if ((stat.mode & 0o077) !== 0) fs.chmodSync(filePath, 0o600);
  } catch {
    // Missing file, or no POSIX modes.
  }
}

/**
 * Close ~/.dorothy to the other accounts on the machine: the directory and its
 * subdirectories to 0700, its files to what their owner already had and no
 * more, so data files land at 0600 and statusline.sh, which Claude Code runs,
 * stays executable by its owner.
 *
 * Called at startup. The directory holds the fleet, the board, the usage
 * ledger and the vault, and an install made before this ran had it at 0755
 * with its files at 0644. One level deep is enough: a directory at 0700 can be
 * neither listed nor entered by anyone else, so nothing below it needs its own
 * mode. A link is never followed, since what it points to may be any file the
 * account owns, and an entry that cannot be changed leaves the others to be.
 */
export function narrowDataDir(dir: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return; // Missing, or not a directory: nothing to narrow.
  }
  const narrow = (p: string) => {
    try {
      const stat = fs.lstatSync(p);
      if (stat.isSymbolicLink()) return;
      const wanted = stat.isDirectory() ? 0o700 : stat.mode & 0o700;
      if ((stat.mode & 0o777) !== wanted) fs.chmodSync(p, wanted);
    } catch {
      // Not ours to change, or gone since the listing.
    }
  };
  for (const name of names) narrow(path.join(dir, name));
  narrow(dir);
}
