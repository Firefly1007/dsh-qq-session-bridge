import test from 'node:test';
import assert from 'node:assert/strict';
import { registerQQDelegateTool } from '../lib/qq-delegate-tool.js';
import { createQQAuthorization } from '../lib/qq-authorization.js';

function harness() {
  let definition;
  let allowed = true;
  const calls = [];
  const agent = { ctx: { tools: { register(tool) { definition = tool; return () => {}; } } } };
  const authorization = { canDelegate: () => allowed };
  const ctx = { agentPresets: { defaultId: 'standard' }, subagents: {
    resolveMaxDepth: () => 3,
    async startActivation(request) { calls.push(request); return { childId: 'child-1' }; },
  } };
  registerQQDelegateTool({ agent, authorization, ctx });
  const signal = new AbortController().signal;
  const invoke = (args = { prompt: 'task', description: 'work' }, caller = agent, callSignal = signal) =>
    definition.execute(args, { agent: caller, signal: callSignal });
  return { agent, ctx, calls, invoke, deny: () => { allowed = false; } };
}

test('each delegation uses the then-current default preset and parent delivery', async () => {
  const h = harness();
  assert.deepEqual(await h.invoke(), { kind: 'activation', subagentId: 'child-1' });
  h.ctx.agentPresets.defaultId = 'bot';
  await h.invoke();
  assert.deepEqual(h.calls.map(call => call.request.agentPreset), ['standard', 'standard']);
  assert.equal(h.calls[0].request.parent, h.agent);
  assert.equal(h.calls[0].provider, 'spawn');
  assert.equal(h.calls[0].delivery, 'parent');
  assert.equal(h.calls[0].request.maxDepth, 3);
  assert.deepEqual(h.calls[0].request.prompt, [{ type: 'text', text: 'task' }]);
});

test('foreign agents, untrusted turns, extra fields and cancellation do not delegate', async () => {
  const h = harness();
  await assert.rejects(h.invoke(undefined, {}), /权限/);
  h.deny();
  await assert.rejects(h.invoke(), /权限/);
  const next = harness();
  await assert.rejects(next.invoke({ prompt: 'task', description: 'work', agent_preset: 'other' }), /不能指定/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(next.invoke(undefined, next.agent, controller.signal));
  assert.equal(h.calls.length, 0);
  assert.equal(next.calls.length, 0);
});

test('missing default preset fails rather than inheriting bot mode', async () => {
  const h = harness();
  h.ctx.agentPresets.defaultId = '';
  await assert.rejects(h.invoke(), /默认工作模式不可用/);
  assert.equal(h.calls.length, 0);
});

test('real QQ authorization admits only an active administrator step', async () => {
  const listeners = new Map();
  let tool;
  const agent = { status: 'running', session: {}, ctx: {
    on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name); },
    tools: { guard() {}, register(definition) { tool = definition; return () => {}; } },
  } };
  const authorization = createQQAuthorization({ agent, controlTools: ['qq_delegate'], administratorIds: ['1'] });
  let calls = 0;
  const ctx = { agentPresets: { defaultId: 'standard' }, subagents: {
    resolveMaxDepth: () => undefined,
    async startActivation() { calls++; return { childId: 'child' }; },
  } };
  registerQQDelegateTool({ agent, authorization, ctx });
  const message = { id: 'm1', role: 'user', source: { kind: 'qq' }, content: [{ type: 'text', text: 'task' }] };
  authorization.admit(message, '1');
  const event = (type, data) => listeners.get('session/event')(agent.session, { type, data });
  event('turn/start', { turn: 1 });
  listeners.get('agent/inbox/claimed')({ agent, message });
  event('step/start', { turn: 1, step: 1 });
  event('user/message', message);
  const exec = { agent, signal: new AbortController().signal };
  await tool.execute({ prompt: 'task', description: 'work' }, exec);
  event('turn/end', { turn: 1 });
  await assert.rejects(tool.execute({ prompt: 'task', description: 'work' }, exec), /权限/);
  assert.equal(calls, 1);
});
