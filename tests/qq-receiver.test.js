import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQReceiver } from '../lib/qq-receiver.js';

function fixture() {
  const sent = [], prompts = [], prepared = [];
  const agent = { id: 'qq-session-test', status: 'idle', session: { header: { id: 'qq-session-test' } } };
  const ctx = { agents: { get: id => id === agent.id ? agent : undefined },
    sessionController: { async resolveAgent() { return { agent }; }, cancel() { return { accepted: true }; } } };
  const config = { selfQQ: '999', whitelist: '1', groupWhitelist: '10' };
  const nap = { selfQQ: '999', extractText: message => message,
    async callAction(_action, { message_id }) { return { message_id, message_type: 'group', group_id: 10,
      user_id: 999, sender: { user_id: 999 }, message: '机器人说过的话' }; },
    async sendAction(action, params) { sent.push({ action, params }); return { status: 'sent' }; } };
  const bindings = { activate: () => true, getPromptBridge: () => ({ async prompt(request) {
    prompts.push(request); return { status: 'accepted' };
  } }) };
  const sessions = { async ensure(key) { return { key, sessionId: agent.id }; } };
  const receiver = createQQReceiver({ ctx, config, nap, sessions, bindings,
    async prepareContent(data) { prepared.push(data); return [{ type: 'text', text: data.input.text }]; },
    signal: new AbortController().signal });
  const event = (user, message) => ({ post_type: 'message', message_type: 'group', group_id: 10,
    user_id: user, message_id: 20, message });
  return { receiver, event, agent, ctx, config, nap, bindings, sent, prompts, prepared };
}
const text = value => ({ type: 'text', data: { text: value } });
const at = { type: 'at', data: { qq: '999' } };

test('only admitted group messages reach the bound Session, with native steer while running', async () => {
  const h = fixture();
  assert.equal((await h.receiver.handle(h.event(2, [at, text('blocked')]))).status, 'ignored');
  assert.equal((await h.receiver.handle(h.event(1, [text('not addressed')]))).status, 'ignored');
  assert.equal((await h.receiver.handle(h.event(1, [at, text('hello')]))).status, 'accepted');
  h.agent.status = 'running';
  assert.equal((await h.receiver.handle(h.event(1, [text('correction')]))).status, 'accepted');
  assert.deepEqual(h.prompts.map(item => [item.senderId, item.mode]), [['1', 'queue'], ['1', 'steer']]);
});

test('group reply must belong to the same group and come from the bot', async () => {
  const h = fixture();
  const event = h.event(1, [{ type: 'reply', data: { id: '7' } }, text('hello')]);
  assert.equal((await h.receiver.handle(event)).status, 'accepted');
  assert.equal(h.prepared[0].reply.text, '机器人说过的话');
  h.nap.callAction = async () => ({ message_id: 7, message_type: 'group', group_id: 11, user_id: 999 });
  const other = fixture();
  other.nap.callAction = h.nap.callAction;
  assert.equal((await other.receiver.handle(event)).status, 'ignored');
});

test('private bot replies are resolved from the current peer history', async () => {
  const h = fixture();
  h.nap.callAction = async (action, params) => {
    assert.equal(action, 'get_friend_msg_history');
    assert.equal(params.user_id, '1');
    return { messages: [{ message_id: 7, message_type: 'private', user_id: 999,
      sender: { user_id: 999 }, message: '私聊回复' }] };
  };
  const event = { ...h.event(1, [{ type: 'reply', data: { id: '7' } }, text('继续')]), message_type: 'private' };
  assert.equal((await h.receiver.handle(event)).status, 'accepted');
  assert.equal(h.prepared[0].reply.text, '私聊回复');
});

test('commands are executed directly and unavailable protection never submits a prompt', async () => {
  const h = fixture();
  const outcome = await h.receiver.handle(h.event(1, [at, text('/stop')]));
  assert.equal(outcome.status, 'command');
  assert.match(h.sent[0].params.message[0].data.text, /已提交停止请求/);
  h.bindings.activate = () => false;
  assert.equal((await h.receiver.handle(h.event(1, [at, text('hello')]))).status, 'failed');
  assert.equal(h.prompts.length, 0);
});
