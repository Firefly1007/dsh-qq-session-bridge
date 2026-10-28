import test from 'node:test';
import assert from 'node:assert/strict';
import { registerQQReadAttachment } from '../lib/qq-read-attachment.js';

function fixture() {
  let tool, allowed = true;
  const ref = { attachmentId: 'sha256:known', name: 'file.txt', bytes: 6 };
  const agent = { ctx: { tools: { register(value) { tool = value; return () => { tool = null; }; } } } };
  const permit = {};
  const authorization = { captureSendPermit: () => permit,
    resolveQQFile: (id, token) => allowed && token === permit && id === ref.attachmentId ? ref : null };
  const attachments = { async *readFileStream() { yield Buffer.from('abc'); yield Buffer.from('def'); } };
  const dispose = registerQQReadAttachment({ agent, authorization, attachments });
  return { agent, tool, dispose, attachments, revoke: () => { allowed = false; },
    execute: args => tool.execute(args, { agent, signal: new AbortController().signal }) };
}

test('reads a bounded range of an authorized QQ attachment and verifies the entire stream', async () => {
  const h = fixture();
  assert.deepEqual(await h.execute({ attachmentId: 'sha256:known', offset: 2, length: 3 }), {
    status: 'ok', message: 'QQ 附件读取成功。', encoding: 'utf8', data: 'cde', offset: 2, nextOffset: 5, size: 6, eof: false,
  });
  assert.equal((await h.execute({ attachmentId: 'sha256:other' })).status, 'failed');
  assert.equal((await h.execute({ attachmentId: 'sha256:known', length: 65537 })).status, 'failed');
  h.dispose();
});

test('revocation and incomplete or failed integrity checks return no file data', async () => {
  const h = fixture();
  h.attachments.readFileStream = async function* () { yield Buffer.from('abc'); h.revoke(); yield Buffer.from('def'); };
  const revoked = await h.execute({ attachmentId: 'sha256:known' });
  assert.equal(revoked.status, 'failed'); assert.equal(revoked.data, undefined);
  const next = fixture();
  next.attachments.readFileStream = async function* () { yield Buffer.from('abc'); throw new Error('digest mismatch'); };
  const corrupt = await next.execute({ attachmentId: 'sha256:known' });
  assert.equal(corrupt.status, 'failed'); assert.equal(corrupt.data, undefined);
  h.dispose(); next.dispose();
});
