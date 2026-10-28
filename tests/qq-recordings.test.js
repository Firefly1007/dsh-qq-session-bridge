import test from 'node:test';
import assert from 'node:assert/strict';
import { getQQRecordings, transcribeQQRecordings } from '../lib/qq-recordings.js';

test('retrieves each authenticated record as MP3 in message order', async () => {
  const calls = [];
  const nap = { async callAction(action, params) {
    calls.push({ action, params });
    return { base64: Buffer.from(params.file).toString('base64') };
  } };
  const result = await getQQRecordings(nap, [{ file: 'first' }, { file: 'second' }]);
  assert.deepEqual(result.map(part => part.audio.toString()), ['first', 'second']);
  assert.deepEqual(calls.map(call => call.action), ['get_record', 'get_record']);
  assert.ok(calls.every(call => call.params.out_format === 'mp3'));
});

test('rejects invalid data and never returns a partial list', async () => {
  let calls = 0;
  const nap = { async callAction() { return { base64: ++calls === 1 ? 'dGVzdA==' : 'not-base64' }; } };
  await assert.rejects(getQQRecordings(nap, [{ file: 'one' }, { file: 'two' }]), /语音数据/);
  await assert.rejects(getQQRecordings(nap, [{ file: 'bad\nfile' }]), /文件标识/);
  await assert.rejects(getQQRecordings(nap, [{ file: 'file:///outside' }]), /文件标识/);
});

test('recognition fails as a whole and can leave unrelated message text to the caller', async () => {
  const signal = new AbortController().signal;
  let calls = 0;
  const nap = { async callAction() { return { base64: 'YXVkaW8=' }; } };
  const response = (code, text) => ({ ok: true, headers: { get: () => code },
    async text() { return '{}'; }, async json() { return { result: { text } }; } });
  const fetcher = async url => url.endsWith('/submit') ? response('20000000')
    : response(++calls === 1 ? '20000000' : '45000151', '第一段');
  const request = { nap, records: [{ file: 'one' }, { file: 'two' }], enabled: true, apiKey: 'key', signal, fetcher };
  assert.deepEqual(await transcribeQQRecordings(request), { text: '', failed: true });
  assert.deepEqual(await transcribeQQRecordings({ ...request, enabled: false }), { text: '', failed: true });
  assert.deepEqual(await transcribeQQRecordings({ ...request, records: [] }), { text: '', failed: false });
  calls = 0;
  const success = await transcribeQQRecordings({ ...request, records: [{ file: 'one' }] });
  assert.match(success.text, /QQ语音转写.*识别误差/);
  assert.match(success.text, /第一段/);
  assert.equal(success.failed, false);
});
