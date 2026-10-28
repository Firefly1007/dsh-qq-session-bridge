import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeQQEvent, createQQAdmission } from '../lib/qq-input.js';

const selfQQ = '999';
const text = (value) => ({ type: 'text', data: { text: value } });
const at = { type: 'at', data: { qq: selfQQ } };
function input(message, values = {}) {
  return normalizeQQEvent({
    post_type: 'message', message_type: 'group', group_id: 10, user_id: 1,
    message_id: -22, sender: { card: '群昵称', nickname: '昵称' }, message, ...values,
  }, selfQQ);
}

test('array input preserves attachments and replies with one shared group key', () => {
  const message = input([at, text('  hello &#91; '),
    { type: 'reply', data: { id: '-12' } },
    { type: 'image', data: { url: 'https://example.com/a?x=1&y=2' } },
    { type: 'record', data: { file: 'a.amr' } }, { type: 'record', data: { file: 'b.amr' } },
    { type: 'file', data: { file_id: 'f1', name: 'file.txt' } },
  ]);
  assert.equal(message.key, 'group:10');
  assert.equal(input([text('x')], { user_id: 2 }).key, message.key);
  assert.deepEqual(message.channel, { type: 'group', id: '10' });
  assert.equal(message.name, '群昵称');
  assert.equal(message.text, 'hello &#91;');
  assert.deepEqual(message.mentions, ['999']);
  assert.equal(message.replyId, '-12');
  assert.equal(message.messageId, '-22');
  assert.equal(message.images.length, 1);
  assert.deepEqual(message.records.map(item => item.file), ['a.amr', 'b.amr']);
  assert.equal(message.files[0].file_id, 'f1');
});

test('CQ strings decode values after parsing and keep escaped CQ syntax as text', () => {
  const message = input('[CQ:at,qq=999][CQ:reply,id=-12] &#91;CQ:at,qq=999&#93; &amp; [CQ:image,url=https://example.com/a?x=a&#44;b&amp;y=1]');
  assert.equal(message.text, '[CQ:at,qq=999] &');
  assert.deepEqual(message.mentions, ['999']);
  assert.equal(message.replyId, '-12');
  assert.equal(message.images[0].url, 'https://example.com/a?x=a,b&y=1');
  assert.equal(input(undefined, { raw_message: 'fallback' }).text, 'fallback');
});

test('pure voice, file, image and replies survive normalization', () => {
  for (const type of ['record', 'file', 'image']) {
    assert.ok(input([{ type, data: { file: 'ref' } }]));
    assert.ok(input(`[CQ:${type},file=ref]`));
  }
  assert.equal(input('[CQ:reply,id=123]').replyId, '123');
  assert.equal(input('[CQ:json,data=test]'), null);
  assert.equal(input(''), null);
  assert.equal(input([at]), null);
});

test('rejects non-message, self, system and malformed account identifiers', () => {
  for (const values of [
    { post_type: 'notice' }, { message_type: 'unknown' }, { user_id: 0 },
    { user_id: 'bad' }, { user_id: Number.MAX_SAFE_INTEGER + 1 },
    { user_id: selfQQ }, { sub_type: 'self' }, { sub_type: 'group_self' }, { group_id: '' },
  ]) assert.equal(input('hello', values), null);
  const privateMessage = input('hello', { message_type: 'private' });
  assert.equal(privateMessage.key, 'private:1');
  assert.equal(privateMessage.gid, '');
  assert.deepEqual(privateMessage.channel, { type: 'private', id: '1' });
});

test('admin bypasses user allowlist but group allowlist still applies', () => {
  const gate = createQQAdmission({ config: { selfQQ, whitelist: '2，3', superUsers: '1', groupWhitelist: '10' } });
  assert.deepEqual(gate.admit(input([at, text('hello')])), {
    allowed: true, reason: 'explicit-trigger', admin: true, command: '',
  });
  assert.equal(gate.admit(input([at, text('hello')], { group_id: 11 })).reason, 'group-not-allowed');
  assert.equal(gate.admit(input([at, text('hello')], { user_id: 4 })).reason, 'user-not-allowed');
  assert.equal(gate.admit(input('hello', { message_type: 'private' })).allowed, true);
  const open = createQQAdmission({ config: { selfQQ } });
  assert.equal(open.admit(input('hello', { message_type: 'private', user_id: 44 })).allowed, true);
  assert.equal(open.admit(input([at, text('hello')])).admin, false);
});

test('wake continuation stays with the member, refreshes, and expires at the boundary', () => {
  let time = 0;
  const gate = createQQAdmission({ config: { selfQQ, groupWakeTimeoutSec: 10 }, now: () => time });
  assert.equal(gate.admit(input('hello')).allowed, false);
  assert.equal(gate.admit(input([at, text('hello')])).allowed, true);
  time = 9000;
  assert.equal(gate.admit(input('continuation')).reason, 'continuation');
  assert.equal(gate.admit(input('other member', { user_id: 2 })).allowed, false);
  time = 18000;
  assert.equal(gate.admit(input('refresh')).allowed, true);
  time = 28000;
  assert.equal(gate.admit(input('expired')).allowed, false);
});

test('a new explicit group trigger transfers the continuation to that member only', () => {
  let time = 0;
  const gate = createQQAdmission({ config: { selfQQ, groupWakeTimeoutSec: 10 }, now: () => time });
  assert.equal(gate.admit(input([at, text('first')])).allowed, true);
  time = 1000;
  assert.equal(gate.admit(input([at, text('second')], { user_id: 2 })).allowed, true);
  assert.equal(gate.admit(input('first again')).allowed, false);
  assert.equal(gate.admit(input('second again', { user_id: 2 })).reason, 'continuation');
  assert.equal(gate.admit(input([at, text('other group')], { group_id: 11 })).allowed, true);
  assert.equal(gate.admit(input('second continues', { user_id: 2 })).allowed, true);
});

test('group commands need explicit trigger even during a continuation window', () => {
  const gate = createQQAdmission({ config: { selfQQ } });
  assert.equal(gate.admit(input([at, text('hello')])).allowed, true);
  for (const command of ['/new', '/stop', '/unknown']) {
    assert.equal(gate.admit(input(command)).reason, 'command-needs-trigger');
    assert.equal(gate.admit(input([at, text(command)])).command, command);
    assert.equal(gate.admit(input([at, text(command)])).allowed, true);
  }
  assert.equal(gate.admit(input('/stop', { message_type: 'private' })).allowed, true);
});

test('only a confirmed reply to the bot is an explicit group trigger', () => {
  const gate = createQQAdmission({ config: { selfQQ } });
  const reply = input('[CQ:reply,id=123]/new');
  assert.equal(gate.admit(reply).allowed, false);
  assert.equal(gate.admit(reply, { replyToBot: true }).allowed, true);
  assert.equal(gate.admit(input('/new'), { replyToBot: true }).allowed, false);
});

test('missing bot identity does not let a malformed mention trigger a group', () => {
  const gate = createQQAdmission({ config: {} });
  assert.equal(gate.admit(input([{ type: 'at', data: { qq: '' } }, text('hello')])).allowed, false);
  assert.equal(gate.admit(input([at, text('hello')]), { selfQQ }).allowed, true);
  assert.equal(gate.admit(null).reason, 'invalid-input');
});
