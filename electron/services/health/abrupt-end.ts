/** Stub, for the cases written first. */
import type { HealthSample } from './samples';
import type { AbruptEnd } from '../error-reports/report';
export function abruptEndPayload(_prev: { startedAt: number; lastWriteAt: number; version: string | null }, _samples: HealthSample[], _crash: string | null): AbruptEnd {
  return { previousVersion: null, uptimeMinutes: null, crashType: null, lastSample: null };
}
