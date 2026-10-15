/** Stub, for the cases written first. */
import type { SlowCall } from './samples';
export class SlowCalls { note(_c: string, _ms: number): void { /* stub */ } take(_n = 3): SlowCall[] { return []; } }
export function timeIpcHandlers(_ipc: { handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => void }, _calls?: SlowCalls): void { /* stub */ }
