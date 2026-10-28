import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareQQContent } from '../lib/qq-content.js';

function fixture() {
  const notifications = [];
  const input = { gid: '10', uid: '1', name: '昵称', messageId: '-2', replyId: '', text: '你好',
    channel: { type: 'group', id: '10' }, records: [], images: [], files: [] };
  return { input, config: {}, agent: {}, nap: {}, signal: new AbortController().signal,
    async feedback(_channel, text) { notifications.push(text); }, async loadMedia() { return []; }, notifications };
}

test('disabled voice is reported while ordinary text and sender metadata still reach the Session', async () => {
  const h = fixture();
  h.input.records.push({ file: 'voice' });
  h.config.asrFailureMessage = '请打字';
  const parts = await prepareQQContent(h);
  assert.deepEqual(h.notifications, ['请打字']);
  assert.match(parts[0].text, /昵称.*QQ 1/);
  assert.match(parts[0].text, /QQ消息 ID：-2/);
  assert.match(parts[0].text, /你好/);
});

test('quotes explicitly indicate unavailable content and native media remains ordered', async () => {
  const h = fixture();
  h.input.replyId = '7';
  h.input.images.push({ file: 'image' });
  h.loadMedia = async () => [{ type: 'image', mediaType: 'image/png', data: 'AQ==' }];
  const parts = await prepareQQContent(h);
  assert.match(parts[0].text, /ID 7.*引用内容不可用/);
  assert.equal(parts[1].type, 'image');
  h.reply = { text: '原文' };
  assert.match((await prepareQQContent(h))[0].text, /ID 7.*原文/);
});

test('a failed voice-only message sends its failure notice without an empty prompt', async () => {
  const h = fixture();
  h.input.text = '';
  h.input.records.push({ file: 'voice' });
  assert.deepEqual(await prepareQQContent(h), []);
  assert.equal(h.notifications.length, 1);
});
