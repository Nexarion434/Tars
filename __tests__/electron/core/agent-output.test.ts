import { describe, it, expect } from 'vitest';
import { emitAgentOutput, onAgentOutput } from '../../../electron/core/agent-output';

/**
 * Who hears an agent terminal's output besides the windows (a Tars server's
 * door, for its clients' streams). The desktop registers no listener, so its
 * terminals behave as before.
 *
 * How it fails:
 * - a listener not called with the agent's id and the chunk
 * - a listener that throws keeping the others from hearing, or the terminal
 *   from going on (emitAgentOutput throwing)
 * - a removed listener still called
 */
describe('onAgentOutput', () => {
  it('hands each chunk to every listener, with the agent it came from', () => {
    const heard: string[] = [];
    const stop = onAgentOutput((agentId, chunk) => heard.push(`${agentId}:${chunk}`));
    emitAgentOutput('a1', 'hello');
    stop();
    expect(heard).toEqual(['a1:hello']);
  });

  it('keeps a throwing listener from the others, and never throws itself', () => {
    const heard: string[] = [];
    const stopBad = onAgentOutput(() => { throw new Error('broken listener'); });
    const stopGood = onAgentOutput((_id, chunk) => heard.push(chunk));
    expect(() => emitAgentOutput('a1', 'x')).not.toThrow();
    stopBad();
    stopGood();
    expect(heard).toEqual(['x']);
  });

  it('stops calling a listener once removed', () => {
    const heard: string[] = [];
    const stop = onAgentOutput((_id, chunk) => heard.push(chunk));
    stop();
    emitAgentOutput('a1', 'after');
    expect(heard).toEqual([]);
  });
});
