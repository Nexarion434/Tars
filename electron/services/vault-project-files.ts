import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { PROJECT_FILES_DIR_NAME, moveNotesOut, projectFilesKey } from '../utils/project-files';

/**
 * The Vault's side of each project's folder, ~/.dorothy/project-files/<key>
 * (2.0.4, the frames "Vault · project folders" of #457): what the project's
 * agents produce, in reports/ and tools/, listed, read and edited from the
 * window. The window is the renderer, which a page with an XSS holds whole
 * (the Audit's requirements for 2.0.4, section 1), so:
 *
 * - it names a file by its folder's key, a subfolder and a name, never by a
 *   path, and each is one segment of its own (R1.1);
 * - every folder and file is checked where it really lies: a link, symbolic
 *   or hard, is never read, written or gone through (R1.2);
 * - text only: 1 MB at most to edit, a longer file read up to its first
 *   200 KB, a write of a script or a text file, 0600 and never executable
 *   (R1.3);
 * - a save never writes over a file an agent changed after it was opened
 *   (mtimeSeen), and a new file never over one that appeared meanwhile.
 *
 * An agent of the project reads and writes the same folder (it is in its
 * --add-dir): it is shared with every agent of the project, not a boundary
 * between them (SECURITY.md).
 */

export const SUBFOLDERS = ['reports', 'tools'] as const;
export type Subfolder = typeof SUBFOLDERS[number];

/** The most the window edits, and writes. */
export const WRITE_MAX_BYTES = 1024 * 1024;
/** What a longer file shows: its beginning, read only. */
export const READ_SHOWN_BYTES = 200 * 1024;
/** The entries a list gives; `more` says how many it left out. */
export const LIST_MAX = 1000;
const NAME_MAX = 200;

/** What the window may write: text and the scripts of tools/, never a program or a page. */
const WRITABLE = new Set(['.md', '.txt', '.json', '.yaml', '.yml', '.sh', '.py', '.ts', '.js', '.mjs']);

export type FileKind = 'markdown' | 'text' | 'code' | 'other';
const KINDS: Record<string, FileKind> = {
  '.md': 'markdown', '.markdown': 'markdown', '.mdx': 'markdown',
  '.txt': 'text', '.json': 'text', '.yaml': 'text', '.yml': 'text', '.toml': 'text', '.csv': 'text', '.log': 'text',
  '.sh': 'code', '.bash': 'code', '.zsh': 'code', '.py': 'code', '.ts': 'code', '.tsx': 'code', '.js': 'code', '.mjs': 'code',
  '.cjs': 'code', '.jsx': 'code', '.rb': 'code', '.go': 'code', '.rs': 'code', '.sql': 'code', '.ps1': 'code',
};
const kindOf = (name: string): FileKind => KINDS[path.extname(name).toLowerCase()] ?? 'other';

export type Failure = { error: string; code: string };
const fail = (code: string, error: string): Failure => ({ code, error });

const root = () => path.join(DATA_DIR, PROJECT_FILES_DIR_NAME);

/** One segment of a name: no separator, no NUL or control character, no colon (a Windows stream), not hidden. */
function segmentOk(s: unknown, max: number): s is string {
  return typeof s === 'string' && s.length > 0 && s.length <= max && s !== '.' && s !== '..'
    && !s.startsWith('.') && !/[/\\:\0-\x1f\x7f]/.test(s);
}

/** A directory where it is spelled, not a link, and really at `expected`. */
function realDir(dir: string, expected: string): boolean {
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    return fs.realpathSync.native(dir) === expected;
  } catch {
    return false;
  }
}

/** The real path of a project folder's subfolder, or why there is none. */
function subfolderOf(key: unknown, sub: unknown): { dir: string } | Failure {
  if (!segmentOk(key, 120)) return fail('invalid_key', 'Not a project folder of the Vault.');
  if (!(SUBFOLDERS as readonly unknown[]).includes(sub)) return fail('invalid_sub', 'Only reports and tools are shown.');
  let rootReal: string;
  try {
    rootReal = fs.realpathSync.native(root());
  } catch {
    return fail('no_folder', 'No project folder yet.');
  }
  const folder = path.join(rootReal, key);
  if (!realDir(path.join(root(), key), folder)) return fail('no_folder', `No project folder ${key}.`);
  const dir = path.join(folder, sub as string);
  if (!realDir(dir, dir)) return fail('no_folder', `${key} has no ${String(sub)} folder, or it is a link.`);
  return { dir };
}

/** A file of a subfolder by its name: where it is, and its state, or why it cannot be. */
function fileOf(key: unknown, sub: unknown, name: unknown): { dir: string; file: string; spelled: string } | Failure {
  if (!segmentOk(name, NAME_MAX)) return fail('invalid_name', 'Not a file name of the Vault.');
  const folder = subfolderOf(key, sub);
  if ('error' in folder) return folder;
  return { dir: folder.dir, file: path.join(folder.dir, name), spelled: path.join(root(), key as string, sub as string, name) };
}

/** A regular file with one name, never a link: what may be read or written over. */
function plainFile(stat: fs.Stats): Failure | null {
  if (stat.isSymbolicLink()) return fail('link', 'This file is a link: the Vault does not follow it.');
  if (!stat.isFile()) return fail('not_file', 'Not a file.');
  if (stat.nlink > 1) return fail('link', 'This file has a second name elsewhere: the Vault does not open it.');
  return null;
}

const runnable = (stat: fs.Stats) => process.platform !== 'win32' && (stat.mode & 0o111) !== 0;

export interface ProjectFolderEntry {
  key: string;
  /** The project's folder name when Tars knows the project, else the key without its hash. */
  name: string;
  projectPath: string | null;
  reports: number | Failure;
  tools: number | Failure;
  /** Where its notes/ went, the first time the Vault saw it. */
  notesMoved?: string;
}

/** Every project folder Tars keeps, named and counted; one that cannot be read is said, never fatal. */
export function listProjectFolders(projects: string[]): ProjectFolderEntry[] {
  const known = new Map<string, string>();
  for (const p of projects) {
    const key = typeof p === 'string' ? projectFilesKey(p) : null;
    if (key && !known.has(key)) known.set(key, p);
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root(), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ProjectFolderEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !segmentOk(e.name, 120)) continue;
    const dir = path.join(root(), e.name);
    const moved = moveNotesOut(dir);
    const count = (sub: Subfolder): number | Failure => {
      const listed = listProjectFiles(e.name, sub);
      return 'error' in listed ? listed : listed.files.length + (listed.more ?? 0);
    };
    const projectPath = known.get(e.name) ?? null;
    out.push({
      key: e.name,
      name: projectPath ? path.basename(projectPath) : e.name.replace(/-[0-9a-f]{10}$/, ''),
      projectPath,
      reports: count('reports'),
      tools: count('tools'),
      ...(moved && 'to' in moved ? { notesMoved: moved.to } : {}),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface ProjectFileEntry { name: string; size: number; mtimeMs: number; kind: FileKind; runnable: boolean }

/** A subfolder's files, newest first, 1,000 at most: no link, no hidden file. */
export function listProjectFiles(key: unknown, sub: unknown): { files: ProjectFileEntry[]; more?: number } | Failure {
  const folder = subfolderOf(key, sub);
  if ('error' in folder) return folder;
  let names: string[];
  try {
    names = fs.readdirSync(folder.dir);
  } catch (err) {
    return fail('unreadable', `${String(sub)} could not be read: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`);
  }
  const files: ProjectFileEntry[] = [];
  for (const name of names) {
    if (!segmentOk(name, NAME_MAX)) continue;
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(path.join(folder.dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    files.push({ name, size: stat.size, mtimeMs: stat.mtimeMs, kind: kindOf(name), runnable: runnable(stat) });
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return files.length > LIST_MAX ? { files: files.slice(0, LIST_MAX), more: files.length - LIST_MAX } : { files };
}

export interface ProjectFileRead {
  name: string;
  /** Where it is, as the system writes it: what "copy path" and "show in folder" use. */
  path: string;
  kind: FileKind;
  size: number;
  mtimeMs: number;
  runnable: boolean;
  /** The text, whole up to 1 MB, its first 200 KB past that; none for a file that is not text. */
  text?: string;
  truncated: boolean;
  editable: boolean;
}

/** A UTF-8 cut at a character's end. */
function cutUtf8(buf: Buffer, max: number): Buffer {
  if (buf.length <= max) return buf;
  let end = max;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end);
}

/** A file's text, or its name and size only when it is not text; never through a link. */
export function readProjectFile(key: unknown, sub: unknown, name: unknown): ProjectFileRead | Failure {
  const at = fileOf(key, sub, name);
  if ('error' in at) return at;
  let fd: number;
  try {
    const before = fs.lstatSync(at.file);
    const refused = plainFile(before);
    if (refused) return refused;
    fd = fs.openSync(at.file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? fail('not_found', 'This file is no longer there.') : fail('unreadable', `It could not be read: ${code ?? (err as Error).message}`);
  }
  try {
    const stat = fs.fstatSync(fd);
    const refused = plainFile(stat);
    if (refused) return refused;
    const base: ProjectFileRead = {
      name: name as string, path: at.spelled, kind: kindOf(name as string), size: stat.size, mtimeMs: stat.mtimeMs,
      runnable: runnable(stat), truncated: false, editable: false,
    };
    if (base.kind === 'other') return base;
    const wanted = stat.size <= WRITE_MAX_BYTES ? stat.size : READ_SHOWN_BYTES + 4;
    const buf = Buffer.alloc(wanted);
    const got = fs.readSync(fd, buf, 0, wanted, 0);
    const bytes = buf.subarray(0, got);
    if (bytes.includes(0)) return { ...base, kind: 'other' };
    const truncated = stat.size > WRITE_MAX_BYTES;
    const text = (truncated ? cutUtf8(bytes, READ_SHOWN_BYTES) : bytes).toString('utf8');
    return { ...base, text, truncated, editable: !truncated };
  } finally {
    fs.closeSync(fd);
  }
}

export type WriteResult = { ok: true; mtimeMs: number } | { changed: true; mtimeMs: number | null } | Failure;

/**
 * A file written from the window: a text file or a script, 1 MB at most, no
 * NUL, 0600. `mtimeSeen` is the time it had when it was opened, null for a
 * new file: a file changed since, or one that appeared, answers `changed`
 * with its time and is left as it is. Written to a new file of its own beside
 * it, then renamed over it: never through a link, never half written.
 */
export function writeProjectFile(key: unknown, sub: unknown, name: unknown, text: unknown, mtimeSeen: unknown): WriteResult {
  const at = fileOf(key, sub, name);
  if ('error' in at) return at;
  if (!WRITABLE.has(path.extname(name as string).toLowerCase())) {
    return fail('extension', `The Vault writes text and scripts only: ${[...WRITABLE].join(', ')}.`);
  }
  if (typeof text !== 'string') return fail('not_text', 'Not text.');
  if (text.includes('\0')) return fail('not_text', 'Text with a NUL byte is not text.');
  if (Buffer.byteLength(text, 'utf8') > WRITE_MAX_BYTES) return fail('too_large', 'Over 1 MB: edit it in your own editor.');
  if (mtimeSeen !== null && typeof mtimeSeen !== 'number') return fail('invalid_time', 'When it was opened is missing.');

  const now = (): fs.Stats | null => {
    try { return fs.lstatSync(at.file); } catch { return null; }
  };
  const current = now();
  if (current) {
    const refused = plainFile(current);
    if (refused) return refused;
    if (mtimeSeen === null || current.mtimeMs !== mtimeSeen) return { changed: true, mtimeMs: current.mtimeMs };
  } else if (mtimeSeen !== null) {
    return { changed: true, mtimeMs: null };
  }

  const temp = path.join(at.dir, `.${name as string}.tars-${process.pid}-${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      fs.writeSync(fd, text, 0, 'utf8');
      fs.fsyncSync(fd);
      if (process.platform !== 'win32') fs.fchmodSync(fd, 0o600);
    } finally {
      fs.closeSync(fd);
    }
    // Looked at again just before the rename: an agent may have written it meanwhile.
    const again = now();
    if (again ? (plainFile(again) || again.mtimeMs !== mtimeSeen) : mtimeSeen !== null) {
      fs.rmSync(temp, { force: true });
      if (again && plainFile(again)) return plainFile(again)!;
      return { changed: true, mtimeMs: again?.mtimeMs ?? null };
    }
    fs.renameSync(temp, at.file);
    return { ok: true, mtimeMs: fs.statSync(at.file).mtimeMs };
  } catch (err) {
    fs.rmSync(temp, { force: true });
    const code = (err as NodeJS.ErrnoException).code;
    return fail('unwritable', `Could not save: ${code === 'EACCES' || code === 'EPERM' ? 'permission denied' : code === 'ENOSPC' ? 'the disk is full' : code ?? (err as Error).message} on ${name as string}.`);
  }
}

export { moveNotesOut } from '../utils/project-files';

/** Where a subfolder, or a file of it, is, as the system writes it: for "show folder" and "show in folder". */
export function locateProjectFile(key: unknown, sub: unknown, name?: unknown): { path: string; isFile: boolean } | Failure {
  if (name === undefined || name === null) {
    const folder = subfolderOf(key, sub);
    return 'error' in folder ? folder : { path: path.join(root(), key as string, sub as string), isFile: false };
  }
  const read = readProjectFile(key, sub, name);
  return 'error' in read ? read : { path: read.path, isFile: true };
}
