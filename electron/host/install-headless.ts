import { Module } from 'module';
import type { HeadlessElectron } from './headless-electron';

/**
 * Make `require('electron')` answer the headless module, for every module the
 * server loads after this call. Called once, first, by electron/server/main.ts;
 * the desktop never calls it.
 *
 * The request is resolved to an id of its own and served from the require
 * cache, so Electron's npm package is never loaded on a server: loading it
 * downloads Electron's binary when it is missing (measured with Electron 44).
 */

const HEADLESS_ID = 'tars:headless-electron';

type Resolve = (request: string, ...rest: unknown[]) => string;
const moduleInternals = Module as unknown as { _resolveFilename: Resolve; _cache: Record<string, unknown> };

let installed = false;

export function installHeadlessElectron(electron: HeadlessElectron): () => void {
  if (installed) throw new Error('The headless electron is already installed');
  installed = true;
  const original = moduleInternals._resolveFilename;
  moduleInternals._resolveFilename = function resolveHeadless(this: unknown, request: string, ...rest: unknown[]) {
    return request === 'electron' ? HEADLESS_ID : original.call(this, request, ...rest);
  };
  const cached = new Module(HEADLESS_ID);
  cached.filename = HEADLESS_ID;
  cached.loaded = true;
  cached.exports = electron;
  moduleInternals._cache[HEADLESS_ID] = cached;
  return () => {
    moduleInternals._resolveFilename = original;
    delete moduleInternals._cache[HEADLESS_ID];
    installed = false;
  };
}
