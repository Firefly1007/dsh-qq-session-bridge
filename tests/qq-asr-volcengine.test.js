import test from 'node:test';
import assert from 'node:assert/strict';
import { submitQQSpeech, queryQQSpeech, transcribeQQSpeechSegments } from '../lib/qq-asr-volcengine.js';

const response = (code, body = {}) => ({ ok: true, status: 200, headers: { get: () => code },
  async json() { return body; }, async text() { return JSON.stringify(body); } });

test('submits local audio as base64 and queries the same task', async () => {
  const calls = [];
  const fetcher = async (url, options) => { calls.push({ url, options }); return calls.length === 1
    ? response('20000000') : response('20000000', { result: { text: '你好' } }); };
  const taskId = await submitQQSpeech({ apiKey: 'test-key', audio: Buffer.from('audio'), format: 'mp3', fetcher });
  assert.equal(JSON.parse(calls[0].options.body).audio.data, Buffer.from('audio').toString('base64'));
  assert.equal(calls[0].options.headers['X-Api-Resource-Id'], 'volc.seedasr.auc');
  assert.equal(calls[0].options.headers['X-Api-Request-Id'], taskId);
  assert.deepEqual(await queryQQSpeech({ apiKey: 'test-key', taskId, fetcher }), { status: 'complete', text: '你好' });
  assert.equal(calls[1].options.headers['X-Api-Request-Id'], taskId);
});

test('uses the returned task id when the server supplies one', async () => {
  const returned = '550e8400-e29b-41d4-a716-446655440000';
  const taskId = await submitQQSpeech({ apiKey: 'test-key', audio: Buffer.from('audio'), format: 'mp3',
    fetcher: async () => response('20000000', { task_id: returned }) });
  assert.equal(taskId, returned);
});

test('pending, silence and provider failure remain distinct', async () => {
  const taskId = '550e8400-e29b-41d4-a716-446655440000';
  const query = code => queryQQSpeech({ apiKey: 'test-key', taskId, fetcher: async () => response(code) });
  assert.equal((await query('20000002')).status, 'pending');
  assert.equal((await query('20000003')).status, 'silent');
  await assert.rejects(query('45000151'), /45000151/);
  await assert.rejects(query('20000000'), /无效结果/);
  await assert.rejects(submitQQSpeech({ apiKey: '', audio: Buffer.from('x'), format: 'mp3' }), /API Key/);
  await assert.rejects(submitQQSpeech({ apiKey: 'test-key', audio: Buffer.from('x'), format: 'mp3',
    fetcher: async () => { throw new Error('network'); } }), error => /状态未知/.test(error.message) && Boolean(error.taskId));
});

test('all segments must succeed before the combined transcript is returned', async () => {
  const segments = [{ audio: Buffer.from('one'), format: 'mp3' }, { audio: Buffer.from('two'), format: 'mp3' }];
  let queries = 0;
  const fetcher = async url => url.endsWith('/submit') ? response('20000000')
    : response(++queries === 1 ? '20000000' : '45000151', { result: { text: '第一段' } });
  await assert.rejects(transcribeQQSpeechSegments({ apiKey: 'test-key', segments, signal: new AbortController().signal, fetcher }), /45000151/);
  assert.equal(queries, 2);
});
