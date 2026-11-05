// Loaded with `node -r` before a Tars server's entry: fails the process the
// moment anything would load Electron's own npm package (with Electron 44 that
// downloads its binary when missing), so a server proven under this guard
// answered every `require('electron')` with the headless module.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- a preload for node -r is CommonJS
const Module = require('module');
const original = Module._load;
Module._load = function guardedLoad(request, parent, isMain) {
  const resolved = Module._resolveFilename(request, parent, isMain);
  if (/node_modules[\\/]electron[\\/]index\.js$/.test(resolved)) {
    throw new Error(`no-electron guard: ${request} resolved to Electron's own package (${resolved})`);
  }
  return original.apply(this, arguments);
};
