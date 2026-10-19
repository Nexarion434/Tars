import { app } from 'electron';
import { guardUncaught } from './core/uncaught-guard';

/**
 * Main's guard against Electron's error box (core/uncaught-guard.ts), listening from main.ts's first import after the
 * compile cache, before any other module loads: an exception thrown while one loads is the guard's too. main.ts tells
 * it when the window is open (uncaught.windowOpened(), right after createWindow).
 */
export const uncaught = guardUncaught(process, { log: line => console.error(line), quit: code => app.exit(code) });
