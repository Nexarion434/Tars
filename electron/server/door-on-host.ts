import { remoteSocketProblem } from '../services/cloud-link/ssh';

/**
 * Where a Docker server's door is on its host
 * (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md, Task 6). The
 * container's own path (`door` in `status`) is not the host's, which a
 * desktop's ssh forward needs; the container is started with
 * `-e TARS_DOOR_ON_HOST=<host path>`, and `status --json` says it as
 * `doorOnHost`, held to the checks a profile's door path meets.
 */
export function doorOnHostFrom(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.TARS_DOOR_ON_HOST;
  return typeof value === 'string' && value !== '' && !remoteSocketProblem(value) ? value : undefined;
}
