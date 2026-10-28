import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, name, inject } from '../lib/bot-mode.js';

test('bot mode fails closed without bridge authorization', () => {
  let guard;
  let created;
  let guidance;
  const actions = [];
  let service;
  const ctx = { tools: {
    restrict: rule => actions.push(rule),
    presentAs: mode => actions.push(mode),
    guard: fn => { guard = fn; },
  }, systemPrompt: { section: section => { guidance = section; return () => {}; } },
  effect: fn => fn(), on: (event, fn) => { if (event === 'agent/created') created = fn; }, get: () => service };
  apply(ctx);
  assert.equal(name, 'qq-bot-mode');
  assert.deepEqual(inject, ['tools', 'systemPrompt']);
  assert.match(guidance.text, /qq_send_text/);
  assert.match(guidance.text, /真实消息来源/);
  assert.deepEqual(actions, ['native']);
  let restriction;
  const agent = { ctx: { tools: {
    schemas: () => [{ name: 'web_search' }, { name: 'host_shell' }, { name: 'send_message' }],
    restrict: rule => { restriction = rule; },
  } } };
  created({ agent });
  assert.deepEqual(restriction, { allow: ['web_search', 'send_message'] });
  const call = { agent: {}, name: 'web_search' };
  assert.match(guard(call), /unavailable/);
  service = { checkBotTool: execution => execution === call ? undefined : 'denied' };
  assert.equal(guard(call), undefined);
  assert.equal(guard({}), 'denied');
  service = { checkBotTool() { throw new Error('service failure'); } };
  assert.match(guard(call), /unavailable/);
});
