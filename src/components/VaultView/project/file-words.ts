/** How the Vault's project files say a time and a size, as the frames `Vault · project folders` write them. */

const two = (n: number) => String(n).padStart(2, '0');

function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "today 14:35" in a list, "17/10" for an earlier day. */
export function listTime(mtimeMs: number, now = Date.now()): string {
  const then = new Date(mtimeMs);
  return sameDay(then, new Date(now)) ? `today ${two(then.getHours())}:${two(then.getMinutes())}` : `${two(then.getDate())}/${two(then.getMonth() + 1)}`;
}

/** "today at 14:35", "17/10 at 09:12": when a file changed, said in a sentence. */
export function changedAt(mtimeMs: number, now = Date.now()): string {
  const then = new Date(mtimeMs);
  const clock = `${two(then.getHours())}:${two(then.getMinutes())}`;
  return sameDay(then, new Date(now)) ? `today at ${clock}` : `${two(then.getDate())}/${two(then.getMonth() + 1)} at ${clock}`;
}

/** "14:41": the time an agent changed a file, said in the notice. */
export function clockOf(mtimeMs: number): string {
  const then = new Date(mtimeMs);
  return `${two(then.getHours())}:${two(then.getMinutes())}`;
}

/** "212 bytes", "6.1 KB", "412 KB", "3.1 MB". */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb < 10 ? kb.toFixed(1) : Math.round(kb)} KB`;
  return `${(kb / 1024).toFixed(1)} MB`;
}

/** The chip beside a file's name: its extension, as the frames write md, sh, png. */
export function extensionOf(name: string): string | null {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : null;
}

/** What runs a tool, for the sentence under it; none for a kind Tars does not name. */
export function runnerOf(name: string): string | null {
  switch (extensionOf(name)) {
    case 'sh': return 'bash';
    case 'py': return 'python3';
    case 'js': case 'mjs': return 'node';
    default: return null;
  }
}
