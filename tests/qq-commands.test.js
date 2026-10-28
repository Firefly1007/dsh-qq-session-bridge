import test from 'node:test';
import assert from 'node:assert/strict';
import { executeQQCommand } from '../lib/qq-commands.js';

test('stop submits the native request without claiming it has completed', async () => {
  const agent = { id: 'qq-session-test', session: { header: { id: 'qq-session-test' } } };
  let target;
  const ctx = { agents: { get: () => agent }, sessionController: { cancel(input) { target = input; return { accepted: true }; } } };
  const result = await executeQQCommand({ ctx, agent, command: '/stop' });
  assert.deepEqual(target, { sessionId: agent.id });
  assert.equal(result.status, 'accepted');
  assert.match(result.text, /提交停止请求/);
});

test('new uses native compaction and reports no work or busy without cancelling', async () => {
  const agent = { id: 'qq-session-test', session: { header: { id: 'qq-session-test' } } };
  const signal = new AbortController().signal;
  let calls = 0;
  const ctx = { agents: { get: () => agent }, agentPresets: { serviceFor(actual, name) {
    assert.equal(actual, agent); assert.equal(name, 'compaction');
    return { async compactNow(actual, received) {
    assert.equal(actual, agent); assert.equal(received, signal);
    if (++calls === 1) return null;
    throw Object.assign(new Error('busy'), { code: 'busy' });
    } };
  } } };
  assert.equal((await executeQQCommand({ ctx, agent, command: '/new', signal })).status, 'unchanged');
  assert.match((await executeQQCommand({ ctx, agent, command: '/new', signal })).text, /正在运行/);
  assert.equal(calls, 2);
});

test('commands fail closed for an unbound or stale agent', async () => {
  const agent = { id: 'qq-session-test', session: { header: { id: 'qq-session-test' } } };
  const ctx = { agents: { get: () => undefined }, sessionController: { cancel() { throw new Error('must not run'); } } };
  assert.equal((await executeQQCommand({ ctx, agent, command: '/stop' })).status, 'failed');
});
