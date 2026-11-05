import { app } from 'electron';

/**
 * True only in a Tars server: plain Node (no `process.versions.electron`) whose
 * `electron` is the headless one (install-headless.ts), which marks its app.
 * False in the desktop, and false in a test that mocks `electron` without the
 * marker: those take the desktop's path, as they always have.
 */
export function isHeadless(versions: { electron?: string } = process.versions, electronApp: unknown = app): boolean {
  return versions.electron === undefined && (electronApp as { headless?: unknown } | undefined)?.headless === true;
}
