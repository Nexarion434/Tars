/** Stub, for the cases written first. */
export interface SlowCall { channel: string; ms: number }
export interface HealthSample {
  at: number; heapUsedMb: number; heapTotalMb: number; rssMb: number; loopP50Ms: number; loopP95Ms: number;
  slowest: SlowCall[]; agents: number; running: number; page: string | null;
}
export const HEALTH_KEEP_MS = 24 * 3_600_000;
export const HEALTH_MAX_BYTES = 256 * 1024;
export function cleanSample(_raw: unknown): HealthSample | null { return null; }
export function appendSample(_file: string, _sample: HealthSample, _now = Date.now()): void { /* stub */ }
export function readSamples(_file: string, _now = Date.now()): HealthSample[] { return []; }
