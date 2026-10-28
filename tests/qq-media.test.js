import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadQQImage, createQQMediaLoader } from '../lib/qq-media.js';

test('QQ images use only pinned HTTPS origins and the host byte limit', async () => {
  const signal = new AbortController().signal;
  const limits = { maxImageBytes: 16, mediaTypes: ['image/png'] };
  const png = Buffer.from('89504e470d0a1a0a0102', 'hex');
  const fetcher = async (url, options) => {
    assert.equal(url.hostname, 'gchat.qpic.cn');
    assert.equal(options.redirect, 'error');
    return { ok: true, body: (async function* () { yield png.subarray(0, 4); yield png.subarray(4); })() };
  };
  const input = { image: { url: 'https://gchat.qpic.cn/download?private=token' }, limits, signal, fetcher };
  assert.deepEqual(await loadQQImage(input), { type: 'image', mediaType: 'image/png', data: png.toString('base64') });
  await assert.rejects(loadQQImage({ ...input, limits: { ...limits, maxImageBytes: 4 } }), /超过/);
  for (const url of ['http://gchat.qpic.cn/a', 'https://gchat.qpic.cn.example.org/a', 'https://127.0.0.1/a',
    'https://user@gchat.qpic.cn/a', 'https://gchat.qpic.cn:444/a']) {
    await assert.rejects(loadQQImage({ ...input, image: { url } }), /来源/);
  }
  await assert.rejects(loadQQImage({ ...input, limits: { ...limits, mediaTypes: ['image/jpeg'] } }), /格式/);
});

test('QQ file admission reads only a stable regular file within the QQ data directory', { skip: process.platform !== 'linux' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const qqHome = path.join(root, 'qq'); fs.mkdirSync(qqHome);
  const file = path.join(qqHome, 'attachment.txt'); fs.writeFileSync(file, 'hello');
  const uploads = [], notices = [];
  const ctx = { fileUploads: { async uploadStream({ data, name }) {
    const chunks = []; for await (const chunk of data) chunks.push(chunk);
    uploads.push(Buffer.concat(chunks).toString());
    return { receiptId: 'receipt', file: { attachmentId: 'sha256:abc', name, bytes: 5 } };
  } }, attachments: {} };
  const nap = { async callAction(action, payload) {
    assert.equal(action, 'get_file'); assert.equal(payload.file_id, 'unique-file-id');
    return { file, file_name: 'attachment.txt' };
  } };
  const load = createQQMediaLoader({ ctx, nap, qqHome });
  const request = { input: { images: [], files: [{ file_id: 'unique-file-id', file: 'attachment.txt', file_size: 5 }],
    channel: { type: 'private', id: '1' } }, agent: { id: 'qq-session-1' }, signal: new AbortController().signal,
    async feedback(_channel, text) { notices.push(text); } };
  const result = await load(request);
  assert.equal(uploads[0], 'hello'); assert.equal(result[1].receiptId, 'receipt');
  assert.match(result[0].text, /sha256:abc/);
  const outside = path.join(root, 'outside'); fs.writeFileSync(outside, 'other');
  nap.callAction = async () => ({ file: outside });
  assert.deepEqual(await load(request), []); assert.equal(notices.length, 1);
  fs.symlinkSync(outside, path.join(qqHome, 'linked'));
  nap.callAction = async () => ({ file: path.join(qqHome, 'linked') });
  assert.deepEqual(await load(request), []); assert.equal(uploads.length, 1);
});
