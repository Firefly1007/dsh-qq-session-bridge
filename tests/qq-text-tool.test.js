import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQAuthorization } from '../lib/qq-authorization.js';
import { QQ_TEXT_TOOL, createQQSendQueue, registerQQTextTool } from '../lib/qq-text-tool.js';

function fixture(options = {}) {
  let tool;
  let current = Object.freeze({});
  const sends = [];
  const events = new Map();
  const agent = {
    id: 'qq-session-main', status: 'running', session: {},
    ctx: {
      tools: { register(value) { tool = value; return () => { tool = undefined; }; }, guard() {} },
      on(name, listener) { events.set(name, listener); return () => events.delete(name); },
    },
  };
  const authorization = options.realAuthorization
    ? createQQAuthorization({ agent, controlTools: ['spawn_agent'] })
    : { captureSendPermit: () => current, canSend: permit => !!current && permit === current };
  const channel = { type: 'private', id: '123' };
  const nap = { async sendAction(...args) { sends.push(args); return { status: 'sent', messageId: sends.length }; } };
  const sendQueue = createQQSendQueue({ agent, authorization });
  const dispose = registerQQTextTool({ agent, sendQueue, nap, channel: options.channel || channel });
  const execute = (args = { text: 'hello' }, values = {}) => tool.execute(args, {
    agent, signal: new AbortController().signal, ...values,
  });
  return {
    agent, authorization, sendQueue, channel, nap, sends, dispose, execute,
    tool: () => tool,
    end() { current = null; },
    next() { current = Object.freeze({}); },
    emit(name, ...args) { events.get(name)?.(...args); },
  };
}

test('registers scoped fixed-target text and sends literal text without CQ interpretation', async () => {
  const h = fixture();
  assert.equal(h.tool().name, QQ_TEXT_TOOL);
  h.channel.id = '999';
  const output = await h.execute({ text: ' [CQ:at,qq=999] hello ' });
  assert.equal(output.status, 'sent');
  assert.equal(output.messageId, 1);
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0][0], 'send_private_msg');
  assert.deepEqual(h.sends[0][1], { user_id: '123', message: [{ type: 'text', data: { text: ' [CQ:at,qq=999] hello ' } }] });
  assert.match(h.tool().output.render({}, output)[0].text, /"status":"sent"/);
  const group = fixture({ channel: { type: 'group', id: '456' } });
  await group.execute();
  assert.equal(group.sends[0][0], 'send_group_msg');
  assert.equal(group.sends[0][1].group_id, '456');
});

test('rejects empty text, target tampering and a child or foreign Agent without dispatch', async () => {
  const h = fixture();
  for (const args of [null, {}, [], { text: '' }, { text: ' \n ' }, { text: 1 }, { text: 'x', group_id: '999' }, { text: 'x', target: 'other' }]) {
    assert.equal((await h.execute(args)).status, 'failed');
  }
  for (const other of [undefined, { id: 'child' }, { ...h.agent }]) {
    assert.equal((await h.execute({ text: 'hello' }, { agent: other })).code, 'WRONG_AGENT');
  }
  assert.equal(h.sends.length, 0);
});

test('serializes sends in call order and returns individual delivery outcomes', async () => {
  const h = fixture();
  const first = Promise.withResolvers();
  h.nap.sendAction = async (...args) => { h.sends.push(args); return h.sends.length === 1 ? first.promise : { status: 'failed', code: 'REJECTED', message: 'denied' }; };
  const one = h.execute({ text: 'one' });
  const two = h.execute({ text: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.sends.length, 1);
  first.resolve({ status: 'sent', messageId: 10 });
  assert.equal((await one).status, 'sent');
  assert.equal((await two).status, 'failed');
  assert.deepEqual(h.sends.map(args => args[1].message[0].data.text), ['one', 'two']);
});

test('queued sends keep their original step permit and cannot move to a later QQ step', async () => {
  const h = fixture();
  const first = Promise.withResolvers();
  h.nap.sendAction = async (...args) => { h.sends.push(args); return first.promise; };
  const one = h.execute({ text: 'one' });
  const two = h.execute({ text: 'two' });
  await new Promise(resolve => setImmediate(resolve));
  h.next();
  first.resolve({ status: 'sent', messageId: 10 });
  await one;
  assert.equal((await two).code, 'NOT_AUTHORIZED');
  assert.equal(h.sends.length, 1);
});

test('step end, cancellation and disposal discard queued sends before dispatch', async () => {
  for (const change of ['end', 'cancel', 'dispose']) {
    const h = fixture();
    const first = Promise.withResolvers();
    h.nap.sendAction = async (...args) => { h.sends.push(args); return first.promise; };
    const one = h.execute({ text: 'one' });
    const abort = new AbortController();
    const two = h.execute({ text: 'two' }, { signal: abort.signal });
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'end') h.end();
    else if (change === 'cancel') abort.abort();
    else h.dispose();
    first.resolve({ status: 'sent', messageId: 10 });
    await one;
    assert.equal((await two).status, 'failed');
    assert.equal(h.sends.length, 1);
  }
});

test('unknown, timeouts and thrown transport errors never resend or use an alternate target', async () => {
  for (const response of [{ status: 'unknown', code: 'SEND_TIMEOUT', message: 'timeout' }, undefined, new Error('transport')]) {
    const h = fixture();
    h.nap.sendAction = async (...args) => { h.sends.push(args); if (response instanceof Error) throw response; return response; };
    const output = await h.execute();
    assert.equal(output.status, 'unknown');
    assert.match(output.message, /可能已送达/);
    assert.equal(h.sends.length, 1);
  }
});

function begin(h, origin) {
  const message = { id: `message-${origin}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'hello' }] };
  if (origin === 'qq') h.authorization.admit(message, '123');
  if (origin === 'proactive') h.authorization.admitProactive(message);
  h.emit('session/event', h.agent.session, { type: 'turn/start', data: { turn: 1 } });
  h.emit('agent/inbox/claimed', { agent: h.agent, message });
  h.emit('session/event', h.agent.session, { type: 'step/start', data: { turn: 1, step: 1 } });
  h.emit('session/event', h.agent.session, { type: 'user/message', data: message });
}

test('real authorization allows QQ/proactive steps and refuses Web and completed rounds', async () => {
  for (const origin of ['qq', 'proactive', 'web']) {
    const h = fixture({ realAuthorization: true });
    begin(h, origin);
    assert.equal((await h.execute()).status, origin === 'web' ? 'failed' : 'sent');
    h.emit('session/event', h.agent.session, { type: 'step/end', data: { turn: 1, step: 1 } });
    assert.equal((await h.execute()).status, 'failed');
    h.emit('session/event', h.agent.session, { type: 'turn/end', data: { turn: 1 } });
    assert.equal(h.sends.length, origin === 'web' ? 0 : 1);
  }
});

test('rejects invalid fixed channels and fails closed if authorization cannot be checked', async () => {
  assert.throws(() => fixture({ channel: { type: 'group', id: '' } }), /fixed QQ channel/);
  assert.throws(() => fixture({ channel: { type: 'private', id: 'other' } }), /fixed QQ channel/);
  const h = fixture();
  h.authorization.captureSendPermit = () => { throw new Error('unavailable'); };
  assert.equal((await h.execute()).code, 'NOT_AUTHORIZED');
  h.authorization.captureSendPermit = () => ({});
  h.authorization.canSend = () => { throw new Error('unavailable'); };
  assert.equal((await h.execute()).code, 'NOT_AUTHORIZED');
  assert.equal(h.sends.length, 0);
});

test('the shared queue orders other send types with text and refuses pending work after stop', async () => {
  const h = fixture();
  const release = Promise.withResolvers();
  const order = [];
  const execution = { agent: h.agent, signal: new AbortController().signal };
  h.nap.sendAction = async () => { order.push('text'); return { status: 'sent', messageId: 1 }; };
  const otherType = h.sendQueue.enqueue(execution, async canDispatch => {
    order.push('other-start');
    await release.promise;
    assert.equal(canDispatch(), true);
    order.push('other-send');
    return { status: 'sent', message: 'other done' };
  });
  const text = h.execute();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(order, ['other-start']);
  release.resolve();
  await otherType;
  await text;
  assert.deepEqual(order, ['other-start', 'other-send', 'text']);
  const pending = h.execute();
  h.sendQueue.stop();
  assert.equal((await pending).code, 'SEND_CANCELLED');
  assert.deepEqual(order, ['other-start', 'other-send', 'text']);
});

test('a shared asynchronous send can recheck the original permit after preparation', async () => {
  for (const change of ['step', 'cancel', 'stop']) {
    const h = fixture();
    const release = Promise.withResolvers();
    const controller = new AbortController();
    let dispatched = false;
    const pending = h.sendQueue.enqueue({ agent: h.agent, signal: controller.signal }, async canDispatch => {
      await release.promise;
      if (!canDispatch()) return { status: 'failed', message: 'preparation expired' };
      dispatched = true;
      return { status: 'sent', message: 'sent' };
    });
    await new Promise(resolve => setImmediate(resolve));
    if (change === 'step') h.next();
    else if (change === 'cancel') controller.abort();
    else h.sendQueue.stop();
    release.resolve();
    assert.equal((await pending).status, 'failed');
    assert.equal(dispatched, false);
  }
});

test('cancellation after dispatch preserves an unknown delivery result without replay', async () => {
  const h = fixture();
  const controller = new AbortController();
  const dispatched = Promise.withResolvers();
  const reply = Promise.withResolvers();
  h.nap.sendAction = async (...args) => {
    h.sends.push(args);
    dispatched.resolve();
    return reply.promise;
  };
  const pending = h.execute({ text: 'once' }, { signal: controller.signal });
  await dispatched.promise;
  controller.abort();
  h.sendQueue.stop();
  reply.resolve({ status: 'unknown', code: 'SEND_CANCELLED', message: 'acknowledgement lost after dispatch' });
  assert.equal((await pending).status, 'unknown');
  assert.equal(h.sends.length, 1);
});

function privateReply(messageId, peer = '123') {
  return { message_id: messageId, message_type: 'private', user_id: peer, sender: { user_id: peer } };
}

test('optional reply verifies the current private or group conversation before sending reply and literal text', async () => {
  const privateChat = fixture();
  const queries = [];
  privateChat.nap.callAction = async (...args) => { queries.push(args); return { messages: [privateReply(-42, '999')] }; };
  assert.equal((await privateChat.execute({ text: '[CQ:at,qq=999] text', replyMessageId: -42 })).status, 'sent');
  assert.equal(queries[0][0], 'get_friend_msg_history');
  assert.equal(queries[0][1].user_id, '123');
  assert.equal(queries[0][1].message_seq, '-42');
  assert.deepEqual(privateChat.sends[0][1].message, [
    { type: 'reply', data: { id: '-42' } }, { type: 'text', data: { text: '[CQ:at,qq=999] text' } },
  ]);
  const group = fixture({ channel: { type: 'group', id: '456' } });
  group.nap.callAction = async () => ({ message_id: 12, message_type: 'group', group_id: 456, user_id: 999 });
  assert.equal((await group.execute({ text: 'group', replyMessageId: 12 })).status, 'sent');
  assert.equal(group.sends[0][1].group_id, '456');
  assert.equal(group.sends[0][1].message[0].data.id, '12');
});

test('plain text never queries a reply and invalid reply identities never query or send', async () => {
  const h = fixture();
  let queries = 0;
  h.nap.callAction = async () => { queries += 1; throw new Error('should not be used'); };
  assert.equal((await h.execute({ text: 'plain' })).status, 'sent');
  assert.equal(queries, 0);
  for (const replyMessageId of [null, undefined, '', '42', 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1]) {
    const output = await h.execute({ text: 'reply', replyMessageId });
    assert.equal(output.code, 'INVALID_REPLY');
    assert.match(output.message, /请勿反复尝试引用/);
  }
  assert.equal(queries, 0);
  assert.equal(h.sends.length, 1);
});

test('zero is a valid numeric reply input but an unavailable history result is rejected', async () => {
  const h = fixture();
  const queries = [];
  h.nap.callAction = async (...args) => { queries.push(args); throw new Error('message_id is empty'); };
  const output = await h.execute({ text: 'zero', replyMessageId: 0 });
  assert.equal(queries[0][0], 'get_friend_msg_history');
  assert.equal(queries[0][1].message_seq, '0');
  assert.equal(output.code, 'REPLY_LOOKUP_FAILED');
  assert.match(output.message, /可选择不引用发送/);
  assert.equal(h.sends.length, 0);
});

test('missing, malformed and ambiguous private history references are refused', async () => {
  const h = fixture();
  for (const reference of [
    null, {}, privateReply(43),
    { ...privateReply(42), message_id: '42' },
    { ...privateReply(42), group_id: 999 },
    { message_id: 42, message_type: 'group', group_id: 123, user_id: 123 },
  ]) {
    h.nap.callAction = async () => ({ messages: reference ? [reference] : [] });
    const output = await h.execute({ text: 'reply', replyMessageId: 42 });
    assert.equal(output.code, 'REPLY_NOT_IN_CHANNEL');
    assert.match(output.message, /无法确认/);
    assert.match(output.message, /请勿反复尝试引用/);
  }
  h.nap.callAction = async () => ({ messages: [privateReply(42), privateReply(42)] });
  assert.equal((await h.execute({ text: 'reply', replyMessageId: 42 })).code, 'REPLY_NOT_IN_CHANNEL');
  const group = fixture({ channel: { type: 'group', id: '456' } });
  group.nap.callAction = async () => ({ message_id: 42, message_type: 'group', group_id: 999 });
  assert.equal((await group.execute({ text: 'reply', replyMessageId: 42 })).code, 'REPLY_NOT_IN_CHANNEL');
  assert.equal(h.sends.length + group.sends.length, 0);
});

test('reply lookup is followed by a fresh check of the captured step and cancellation', async () => {
  for (const change of ['step', 'cancel', 'stop', 'dispose']) {
    const h = fixture();
    const query = Promise.withResolvers();
    const started = Promise.withResolvers();
    const controller = new AbortController();
    h.nap.callAction = async () => { started.resolve(); return query.promise; };
    const pending = h.execute({ text: 'reply', replyMessageId: 42 }, { signal: controller.signal });
    await started.promise;
    if (change === 'step') h.next();
    else if (change === 'cancel') controller.abort();
    else if (change === 'stop') h.sendQueue.stop();
    else h.dispose();
    query.resolve({ messages: [privateReply(42)] });
    assert.equal((await pending).status, 'failed');
    assert.equal(h.sends.length, 0);
  }
});

test('reply failures advise the model but impose no retry counter or persistent penalty', async () => {
  const h = fixture();
  let queries = 0;
  h.nap.callAction = async () => { queries += 1; throw new Error('not found'); };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const output = await h.execute({ text: 'reply', replyMessageId: 42 });
    assert.equal(output.code, 'REPLY_LOOKUP_FAILED');
    assert.match(output.message, /引用失败，请勿反复尝试引用，可选择不引用发送/);
  }
  assert.equal(queries, 2);
  h.nap.callAction = async () => ({ messages: [privateReply(42)] });
  h.nap.sendAction = async (...args) => { h.sends.push(args); return { status: 'failed' }; };
  const failed = await h.execute({ text: 'reply', replyMessageId: 42 });
  assert.equal(failed.status, 'failed');
  assert.match(failed.message, /具体原因未确认/);
  assert.match(failed.message, /请勿反复尝试引用/);
  h.nap.sendAction = async (...args) => { h.sends.push(args); return { status: 'unknown', code: 'SEND_TIMEOUT' }; };
  const unknown = await h.execute({ text: 'reply', replyMessageId: 42 });
  assert.equal(unknown.status, 'unknown');
  assert.doesNotMatch(unknown.message, /引用失败/);
  assert.equal(h.sends.length, 2);
});
