/** When the process under a pid started. Stub: written failures first. */
export interface ProcessStartDeps {
  execFileSync?: (file: string, args: readonly string[], opts: { env?: NodeJS.ProcessEnv }) => string;
  readFile?: (path: string) => string;
}

export function processStartOf(pid: number, platform: NodeJS.Platform = process.platform, deps: ProcessStartDeps = {}): string | null {
  void pid; void platform; void deps;
  throw new Error('not yet');
}
