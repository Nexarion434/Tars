/**
 * Where a link or a picture in a project's report leads, in the Vault (2.0.4, #471; frame `Vault · project folders
 * · states`, "a link in a report"). An agent wrote the report: a link may open a file of its own folder here, or a
 * page in the browser, and nothing else; a picture is never fetched, whatever it names. Its tests:
 * __tests__/lib/report-links.test.ts.
 */

export type ReportLinkTarget =
  | { kind: 'page'; url: string }
  | { kind: 'file'; name: string }
  | { kind: 'text' };

const PAGE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);
const TEXT: ReportLinkTarget = { kind: 'text' };

/** `href` as the report wrote it; `names`, the files of the folder the report is in. */
export function reportLinkTarget(href: string, names: readonly string[]): ReportLinkTarget {
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return TEXT;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed);
  if (scheme) {
    if (!PAGE_SCHEMES.has(`${scheme[1].toLowerCase()}:`)) return TEXT;
    try {
      new URL(trimmed);
    } catch {
      return TEXT;
    }
    return { kind: 'page', url: trimmed };
  }
  const bare = trimmed.replace(/#.*$/, '').replace(/^\.\//, '');
  let name: string;
  try {
    name = decodeURIComponent(bare);
  } catch {
    return TEXT;
  }
  if (!name || /^\.+$/.test(name) || /[\\/:~]/.test(name) || name.startsWith('.')) return TEXT;
  return names.includes(name) ? { kind: 'file', name } : TEXT;
}
