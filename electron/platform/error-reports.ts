/**
 * Whether this platform's build may send error reports at all.
 *
 * The reports go to Noah's Sentry project (electron/services/error-reports),
 * and Noah has not agreed to receive the Windows port's. So on win32 they are
 * off and the Settings row is hidden, whatever `errorReportsEnabled` says: a
 * settings file edited by hand, or copied from a Mac, starts nothing (decision
 * D16, Nicolas, 2026-09-28). darwin and linux are upstream's, unchanged.
 * The renderer holds the same line in src/lib/error-reports.ts
 * (errorReportsOffered), which cannot import this file.
 */
export function errorReportsAvailable(platform: NodeJS.Platform = process.platform): boolean {
  return platform !== 'win32';
}
