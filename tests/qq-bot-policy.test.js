import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQBotPolicy } from '../lib/qq-bot-policy.js';

test('bot policy binds live root instances and limits QQ, delegation and child tools', () => {
  const live = new Map();
  const ctx = { agents: { get: id => live.get(id) }, agentPresets: { composedPreset: scope => scope.preset } };
  const policy = createQQBotPolicy(ctx);
  const root = { id: 'qq-session-1', ctx: { preset: 'bot' }, session: { header: { id: 'qq-session-1' } } };
  const child = { id: 'child', ctx: { preset: 'bot' }, session: { header: { id: 'child', origin: 'subagent', parentSession: root.id } } };
  live.set(root.id, root);
  live.set(child.id, child);
  let send = false;
  let delegate = false;
  policy.registerRoot(root, { canSend: () => send, canDelegate: () => delegate });
  const check = (agent, name, args = {}) => policy.checkBotTool({ agent, name, arguments: args });
  assert.equal(check(root, 'web_search'), undefined);
  assert.match(check(root, 'qq_send_text'), /not authorized/);
  assert.match(check(root, 'qq_delegate'), /not authorized/);
  send = true;
  delegate = true;
  assert.equal(check(root, 'qq_send_text'), undefined);
  assert.equal(check(root, 'send_message'), undefined);
  assert.match(check(root, 'bash'), /not authorized/);
  assert.match(check(child, 'web_fetch'), /not authorized/);
  assert.match(check(child, 'send_message', { agent_id: root.id }), /not authorized/);
  assert.match(check(child, 'send_message', { agent_id: 'other' }), /not authorized/);
  assert.match(check(child, 'qq_send_text'), /not authorized/);
  assert.match(check(child, 'qq_delegate'), /not authorized/);
  root.ctx.preset = 'other';
  assert.match(check(root, 'web_search'), /not ready/);
  root.ctx.preset = 'bot';
  live.set(root.id, { id: root.id });
  assert.match(check(child, 'send_message', { agent_id: root.id }), /not authorized/);
  policy.revokeRoot(root);
  assert.match(check(root, 'web_search'), /not ready/);
});

test('rejects malformed roots and unregistered or stale instances', () => {
  const ctx = { agents: { get: () => undefined }, agentPresets: { composedPreset: () => 'bot' } };
  const policy = createQQBotPolicy(ctx);
  assert.throws(() => policy.registerRoot({ id: 'qq-session-1', session: { header: { id: 'other' } } }, {}), TypeError);
  assert.match(policy.checkBotTool({ name: 'web_search' }), /not ready/);
});
