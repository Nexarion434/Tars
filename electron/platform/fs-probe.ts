import * as fs from 'fs';

/**
 * The two questions the platform layer asks the disk. Injected everywhere so
 * the Windows rules are tested on any host with an in-memory disk, and the
 * real one is used in production.
 */
export interface FsProbe {
  /** True for an existing regular file (a directory named `x.exe` is not one). */
  isFile(p: string): boolean;
  /** The file as UTF-8 text. Throws as fs.readFileSync does. */
  readFile(p: string): string;
}

export const realFs: FsProbe = {
  isFile(p) {
    try {
      return fs.statSync(p).isFile();
    } catch {
      // Missing, unreadable or a broken link: not a file we can start.
      return false;
    }
  },
  readFile(p) {
    return fs.readFileSync(p, 'utf8');
  },
};

/** An environment block as the spawners take it. */
export type Env = Record<string, string | undefined>;
