/**
 * The version Settings prints for a CLI, out of whatever its `--version` answers: the number alone, so a list can
 * print the command before it (`codex 0.163.0`, where Codex answers `codex-cli 0.163.0`).
 *
 * `shell:version` hands back the raw output, the right contract for a generic handler, so the tidying is here. The
 * line read is the first that holds a version (a banner may come first); a parenthesised note at its very end is
 * dropped if something is left (Claude Code's `(Claude Code)`, Amp's `(released ..., 1h ago)`, which made a column
 * headed version read `1h ago`, then `2h ago`), and so is whatever comes before the number, the CLI naming itself.
 * A note in the middle of the line is left alone. No version in the answer, no version: null.
 */
export function versionNumber(raw: string | null | undefined): string | null {
  const line = (raw ?? '').split('\n').map((l) => l.trim()).find((l) => /\d+\.\d+/.test(l));
  if (!line) return null;
  const noted = line.replace(/\s*\([^()]*\)$/, '').trim() || line;
  const at = noted.search(/(?:^|\s)v?\d+\.\d/);
  return at <= 0 ? noted : noted.slice(at).trim();
}
