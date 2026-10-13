/**
 * The folder a project's memory row names when an older Tars kept that
 * memory under a folder name Claude never reads (ProjectMemory.olderCopy,
 * PR 375): `<projects>/<folder>/memory` named by `<folder>`, the part that
 * differs from Claude's own. Null when there is no older copy. Tests:
 * __tests__/lib/older-copy.test.ts.
 */
export function olderCopyFolder(olderCopy: string | undefined): string | null {
  const parts = (olderCopy ?? '').trim().split(/[\\/]+/).filter(Boolean);
  if (parts.length === 0) return null;
  return parts[parts.length - 1] === 'memory' && parts.length > 1 ? parts[parts.length - 2] : parts[parts.length - 1];
}
