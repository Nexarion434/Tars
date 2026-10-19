import { expect, it } from 'vitest';

// Run by env-isolation.test.ts with these set in the environment it starts vitest in, as an agent's terminal has them.
it('starts without what Tars hands its agents, and with the suite\'s own opt-ins', () => {
  expect(process.env.TARS_CLAUDE_ACCOUNT).toBeUndefined();
  expect(process.env.TARS_CHATS_READ).toBeUndefined();
  expect(process.env.TARS_INSTANCE_ID).toBeUndefined();
  expect(process.env.TARS_STRESS).toBe('kept');
  expect(process.env.TARS_REAL_CLAUDE).toBe('kept');
  expect(process.env.TARS_HERMES_TREE).toBe('kept');
  expect(process.env.TARS_HERMES_PYTHON).toBe('kept');
});
