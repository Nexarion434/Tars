/**
 * What the data folder notice says (2.0.4, #473's app:dataDir; frame `Data folder · notice`): main's notice when two
 * data folders stand, the folder it goes on from when the move to ~/.tars was refused, nothing otherwise. The home
 * folder is written ~, as the frame writes it. Its tests: __tests__/lib/data-folder-notice.test.ts.
 */

/** The home folder at the start of a macOS, Linux or Windows path, wherever it stands in a sentence. */
const HOME_IN_TEXT = /(?:\/(?:Users|home)\/[^/\s,]+(?=\/)|[A-Za-z]:\\Users\\[^\\\s,]+(?=\\))/g;

const tildeIn = (text: string) => text.replace(HOME_IN_TEXT, '~');

/** The folder a refused move would have made: `.tars` beside the folder Tars goes on from, with its separator. */
function besideIt(dir: string): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  const cut = dir.lastIndexOf(sep);
  return cut > 0 ? `${dir.slice(0, cut)}${sep}.tars` : `.tars`;
}

export function dataFolderNotice(answer: { dir: string; did: string; notice?: unknown } | null | undefined): string | null {
  if (!answer) return null;
  if (answer.did === 'both') {
    return typeof answer.notice === 'string' && answer.notice.trim()
      ? tildeIn(answer.notice)
      : `Two data folders stand: Tars runs on ${tildeIn(answer.dir)}.`;
  }
  if (answer.did === 'kept-old') {
    const dir = tildeIn(answer.dir);
    return `Tars could not move ${dir} to ${tildeIn(besideIt(answer.dir))}: it goes on from ${dir}, and tries again at each start.`;
  }
  return null;
}
