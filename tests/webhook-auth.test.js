import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { mkdtempSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNapCat } from '../lib/napcat.js';

test('webhook accepts only a valid signature over the original body', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'napcat-webhook-'));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  try {
    let handler;
    const web = { register(route) { handler = route.handler; return () => {}; } };
    const log = { info() {}, warn() {} };
    const config = { napcatToken: 'secret', webhookPath: '/hook' };
    const received = [];
    const nap = createNapCat(config, { get: () => web }, log);
    await nap.startWebhook(event => received.push(event));
    const body = Buffer.from(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1, message_id: 42, message: '你好' }));
    const valid = 'sha1=' + createHmac('sha1', config.napcatToken).update(body).digest('hex');
    async function post(payload, signature) {
      const req = Readable.from([payload]);
      req.headers = signature ? { 'x-signature': signature } : {};
      const res = { setHeader() {}, end() {} };
      await handler(req, res);
      return res.statusCode;
    }
    assert.equal(await post(body, ''), 401);
    assert.equal(await post(body, 'sha1=bad'), 401);
    assert.equal(await post(Buffer.concat([body, Buffer.from(' ')]), valid), 401);
    assert.equal(received.length, 0);
    assert.equal(await post(body, valid), 200);
    assert.equal(received.length, 1);
    for (const [index, type] of ['record', 'file', 'reply'].entries()) {
      const payload = Buffer.from(JSON.stringify({ post_type: 'message', message_type: 'private', user_id: 1,
        message_id: index + 50, message: [{ type, data: { file: 'message-file' } }] }));
      const signature = 'sha1=' + createHmac('sha1', config.napcatToken).update(payload).digest('hex');
      assert.equal(await post(payload, signature), 200);
    }
    assert.equal(received.length, 4);
    config.napcatToken = '';
    assert.equal(await post(body, valid), 401);
    assert.equal(received.length, 4);
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    rmdirSync(path.join(home, 'qq-session-bridge'));
    rmdirSync(home);
  }
});
