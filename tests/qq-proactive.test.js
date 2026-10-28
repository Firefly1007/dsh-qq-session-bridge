import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQProactive, QQ_PROACTIVE_PROMPT } from '../lib/qq-proactive.js';

test('idle proactive work uses a fixed native input and only counts actual sends', async () => {
  let now = 1000, service;
  const calls = [];
  const agent = { status: 'idle' };
  const bindings = { getPromptBridge() { return { async proactive(request) {
    calls.push(request);
    service.onTurnFinished({ key: 'private:1', agent, sent: calls.length === 1, messageIds: new Set(['proactive-id']) });
    return { status: 'accepted', messageId: 'proactive-id' };
  } }; } };
  service = createQQProactive({ config: { proactiveCooldownSec: 60 }, bindings });
  service.setNow(() => now); service.setRng(() => 0);
  service.noteUser({ key: 'private:1', channel: { type: 'private', id: '1' }, text: 'hello' }, agent);
  now += 61000;
  await service.check('private:1');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content[0].text, QQ_PROACTIVE_PROMPT);
  assert.equal(service.status().firedCount, 1);
  now += 61000;
  await service.check('private:1');
  assert.equal(service.status().firedCount, 1);
  service.stopAll();
});

test('busy sessions, non-enabled groups and farewell do not start proactive work', async () => {
  let now = 1000, calls = 0;
  const agent = { status: 'running' };
  const service = createQQProactive({ config: { proactiveCooldownSec: 60, proactiveGroups: '11' },
    bindings: { getPromptBridge: () => ({ async proactive() { calls++; return { status: 'skipped' }; } }) } });
  service.setNow(() => now); service.setRng(() => 0);
  service.noteUser({ key: 'group:10', channel: { type: 'group', id: '10' }, text: 'hello' }, agent);
  service.noteUser({ key: 'group:11', channel: { type: 'group', id: '11' }, text: 'hello' }, agent);
  service.noteUser({ key: 'private:2', channel: { type: 'private', id: '2' }, text: '晚安' }, agent);
  now += 61000;
  await service.check('group:10'); await service.check('group:11'); await service.check('private:2');
  assert.equal(calls, 0);
  agent.status = 'idle';
  await service.check('group:11');
  assert.equal(calls, 1);
  service.stopAll();
});

test('a different turn ending during admission cannot be mistaken for the proactive turn', async () => {
  let now = 1000, service;
  const agent = { status: 'idle' };
  const serviceConfig = { proactiveCooldownSec: 60 };
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  service = createQQProactive({ config: serviceConfig, bindings: { getPromptBridge: () => ({ async proactive() {
    await gate; return { status: 'accepted', messageId: 'proactive-id' };
  } }) } });
  service.setNow(() => now); service.setRng(() => 0);
  service.noteUser({ key: 'private:1', channel: { type: 'private', id: '1' }, text: 'hi' }, agent);
  now += 61000;
  let finished = false;
  const check = service.check('private:1').then(() => { finished = true; });
  service.onTurnFinished({ key: 'private:1', agent, sent: true, messageIds: new Set(['other-id']) });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false);
  service.onTurnFinished({ key: 'private:1', agent, sent: false, messageIds: new Set(['proactive-id']) });
  await check;
  assert.equal(service.status().firedCount, 0);
  service.stopAll();
});
