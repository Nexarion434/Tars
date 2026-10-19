import * as fs from 'fs';
import * as path from 'path';
import { PRIVATE_DIR } from '../constants';
import { isUnder, samePath } from '../platform/path-compare';

/**
 * Why a folder may not be handed to an agent besides its project (claude's and
 * codex's --add-dir, gemini's --include-directories), or null when it may.
 *
 * Never ~/.tars-private: nothing under it is ever passed to a CLI (CLAUDE.md),
 * and create_agent and update_agent took any folder that existed (the Audit's
 * L1 on #480). Refused: that folder, a folder inside it, and a folder that holds
 * it (the home folder, its parents, the root), by the spelling given and by
 * where its links lead. The comparisons are path-compare's, so a Windows path
 * is read as Windows reads it.
 */
export function handedFolderProblem(folder: string, where: { privateDir: string } = { privateDir: PRIVATE_DIR }): string | null {
  const places = (p: string) => {
    const spelled = path.resolve(p);
    try {
      return [spelled, fs.realpathSync.native(spelled)];
    } catch {
      // Not made yet, or not readable: its spelling is all there is to compare.
      return [spelled];
    }
  };
  const privates = places(where.privateDir);
  for (const place of places(folder)) {
    for (const priv of privates) {
      if (samePath(place, priv) || isUnder(place, priv)) {
        return `${folder} is ${samePath(place, priv) ? '' : 'inside '}${where.privateDir}, which agents are never handed`;
      }
      if (isUnder(priv, place)) {
        return `${folder} holds ${where.privateDir}, which agents are never handed: name a folder of its own`;
      }
    }
  }
  return null;
}
