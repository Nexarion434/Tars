import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from '../constants';
import { pathKey } from '../platform/path-compare';

/**
 * The folder Tars keeps for each project: ~/.dorothy/project-files/<key>, with
 * tools/ and reports/, where the project's agents keep the scripts and the
 * reports worth keeping (notes/ went in 2.0.4: moveNotesOut). The Vault shows
 * and edits them (services/vault-project-files.ts). They kept them in temporary folders, which
 * a session's end or a cleanup empties, or under ~/Documents, which iCloud
 * evicts (a read of an evicted file then blocks). Outside the repository, so
 * nothing there is committed by mistake; never deleted by Tars.
 *
 * The key is the project folder's name, readable, then ten hex digits of the
 * SHA-256 of the place as the platform compares paths (platform/path-compare's
 * pathKey: on Windows, case and separators do not count). Two spellings of one
 * project share a folder, two projects of one name do not.
 */

export const PROJECT_FILES_DIR_NAME = 'project-files';
export const PROJECT_FILES_SUBDIRS = ['tools', 'reports'] as const;

/** Names Windows keeps for devices, whatever follows them. */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)$/;

/**
 * A file name every system takes: lower case letters, digits and dashes, 40 at
 * most. An accented letter keeps its letter: NFKD writes it as the letter and a
 * combining mark, and the mark goes (`Été` is `ete`, not `e-te`).
 */
function slugOf(name: string): string {
  const slug = name.normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 40).replace(/-+$/, '');
  if (!slug) return 'project';
  return WINDOWS_DEVICE.test(slug) ? `project-${slug}` : slug;
}

/** The key of a project's folder, or null for a path that is not absolute. */
export function projectFilesKey(projectPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const p = platform === 'win32' ? path.win32 : path.posix;
  if (!projectPath || !p.isAbsolute(projectPath)) return null;
  const place = p.normalize(projectPath);
  const hash = crypto.createHash('sha256').update(pathKey(place, platform), 'utf8').digest('hex').slice(0, 10);
  return `${slugOf(p.basename(place))}-${hash}`;
}

/** Where a project's folder is, made or not; null for a path that is not absolute. */
export function projectFilesDir(projectPath: string, platform: NodeJS.Platform = process.platform): string | null {
  const key = projectFilesKey(projectPath, platform);
  return key ? path.join(DATA_DIR, PROJECT_FILES_DIR_NAME, key) : null;
}

/** A project's folder, or why it has none, as an agent's identity says it. */
export type ProjectFolder = { dir: string; why?: undefined } | { dir: null; why: string };

/**
 * A project's folder, made if it is not there: what is in it is left as it is.
 * None when the path is not absolute or the folder cannot be made (a full disk,
 * a folder Tars may not write), and why, which an agent's identity then says
 * rather than naming a folder that is not there or blaming the project's path.
 */
export function ensureProjectFiles(projectPath: string): ProjectFolder {
  const dir = projectFilesDir(projectPath);
  if (!dir) return { dir: null, why: 'its path is not absolute' };
  try {
    for (const sub of PROJECT_FILES_SUBDIRS) fs.mkdirSync(path.join(dir, sub), { recursive: true });
    moveNotesOut(dir);
    return { dir };
  } catch (err) {
    console.warn(`[project-files] ${dir} could not be made:`, (err as Error).message);
    return { dir: null, why: `${dir} could not be made: ${(err as Error).message}` };
  }
}

/** Today as a file name takes it. */
const today = () => new Date().toISOString().slice(0, 10);

/**
 * notes/ goes (2.0.4, the maintainer's decision of 18/10: a project's folder
 * holds reports/ and tools/): its files move, whole and as they are, into
 * reports/notes, or reports/notes-<date> when that is taken. Nothing in it is
 * deleted. An empty notes/ is removed; a notes/ that is a link is left alone.
 * Returns where they went, or null when there was nothing to move.
 */
export function moveNotesOut(dir: string): { to: string } | { left: string } | null {
  const notes = path.join(dir, 'notes');
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(notes);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return { left: `${notes} is not a folder: left as it is` };
  try {
    if (fs.readdirSync(notes).length === 0) {
      fs.rmdirSync(notes);
      return null;
    }
    const reports = path.join(dir, 'reports');
    fs.mkdirSync(reports, { recursive: true });
    let to = path.join(reports, 'notes');
    for (let n = 1; fs.existsSync(to); n++) to = path.join(reports, n === 1 ? `notes-${today()}` : `notes-${today()}-${n}`);
    fs.renameSync(notes, to);
    console.log(`[project-files] ${notes} moved to ${to}: a project's folder keeps reports/ and tools/`);
    return { to };
  } catch (err) {
    console.warn(`[project-files] ${notes} could not be moved, and stays: ${(err as Error).message}`);
    return { left: `${notes} could not be moved: ${(err as Error).message}` };
  }
}
