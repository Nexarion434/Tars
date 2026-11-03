import { describe, it, expect } from 'vitest';
import { doorOnHostFrom } from '../../../electron/server/door-on-host';

/**
 * Where a Docker server's door is on its host (docs/superpowers/plans/2026-11-03-tars-cloud-m3.md,
 * Task 6): the container is started with TARS_DOOR_ON_HOST, and `status
 * --json` names it as `doorOnHost`, since the container's own path is not
 * the host's.
 *
 * How it fails, written before the code:
 * 1. a value that is not an absolute path, holds `:` (it splits ssh's -L)
 *    or whitespace, said anyway
 * 2. a good value not said, or said with spaces around it
 * 3. something said when the variable is unset or empty
 */

describe('doorOnHostFrom', () => {
  it('1. refuses what the socket checks refuse', () => {
    for (const value of ['relative/door.sock', '/a:b/door.sock', '/a b/door.sock', '/a\n/door.sock']) {
      expect(doorOnHostFrom({ TARS_DOOR_ON_HOST: value }), JSON.stringify(value)).toBeUndefined();
    }
  });
  it('2. says a good one', () => {
    expect(doorOnHostFrom({ TARS_DOOR_ON_HOST: '/home/ubuntu/tars-cloud/home/.tars-private/door.sock' })).toBe('/home/ubuntu/tars-cloud/home/.tars-private/door.sock');
  });
  it('3. nothing without it', () => {
    expect(doorOnHostFrom({})).toBeUndefined();
    expect(doorOnHostFrom({ TARS_DOOR_ON_HOST: '' })).toBeUndefined();
  });
});
