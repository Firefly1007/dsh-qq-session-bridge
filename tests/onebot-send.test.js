import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNapCat } from '../lib/napcat.js';

const ok = data => new Response(JSON.stringify({ status: 'ok', retcode: 0, data }));
const reply = (socket, frame, response) => socket.onmessage({ data: JSON.stringify({ ...response, echo: frame.echo }) });

async function withNap(operation, { http = () => ok({ message_id: 7 }), ws } = {}) {
  const previous = { fetch: globalThis.fetch, WebSocket: globalThis.WebSocket, home: process.env.DSH_HOME };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'onebot-send-'));
  process.env.DSH_HOME = directory;
  const httpSends = [];
  const sockets = [];
  let connection;
  const config = { napcatHttpUrl: 'http://127.0.0.1:3000', napcatWsUrl: 'ws://127.0.0.1:3001', selfQQ: '10000' };
  globalThis.fetch = async (url, options) => {
    const action = new URL(url).pathname.slice(1);
    if (action === 'get_status') return ok({ online: true, good: true });
    if (action === 'get_login_info') return ok({ user_id: 10000, nickname: 'fixture' });
    httpSends.push({ action, options });
    return http(action, options);
  };
  globalThis.WebSocket = class {
    readyState = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(body) {
      const frame = JSON.parse(body);
      this.sent.push(frame);
      ws?.(this, frame);
    }
    close() { this.readyState = 3; this.onclose?.({ code: 1000 }); }
  };
  const nap = createNapCat(config, {}, { info() {}, warn() {} });
  const state = { nap, config, httpSends, sockets, async openWs() {
    connection = nap.connectWs(() => {});
    const socket = sockets.at(-1);
    socket.readyState = 1;
    socket.onopen();
    await new Promise(resolve => setImmediate(resolve));
    return socket;
  } };
  try { await operation(state); }
  finally {
    connection?.dispose();
    globalThis.fetch = previous.fetch;
    globalThis.WebSocket = previous.WebSocket;
    if (previous.home === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous.home;
    assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test('HTTP send uses the named path and top-level parameters and preserves the response', async () => {
  await withNap(async ({ nap, httpSends }) => {
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'hello' });
    assert.equal(result.status, 'sent');
    assert.equal(result.transport, 'http');
    assert.equal(result.messageId, 7);
    assert.deepEqual(result.response, { status: 'ok', retcode: 0, data: { message_id: 7 } });
    const body = JSON.parse(httpSends[0].options.body);
    assert.equal(httpSends[0].action, 'send_private_msg');
    assert.equal(body.user_id, '123');
    assert.equal(body.message, 'hello');
    assert.equal(typeof body.echo, 'string');
    assert.equal(body.params, undefined);
    assert.equal(body.action, undefined);
  });
});

test('existing read calls also use top-level HTTP parameters', async () => {
  await withNap(async ({ nap, httpSends }) => {
    assert.deepEqual(await nap.callAction('get_msg', { message_id: 123 }), { message_id: 7 });
    const body = JSON.parse(httpSends[0].options.body);
    assert.equal(body.message_id, 123);
    assert.equal(body.params, undefined);
  });
});

test('an open WS is selected before sending and supports WS-only configurations', async () => {
  await withNap(async ({ nap, config, httpSends, openWs }) => {
    const socket = await openWs();
    config.napcatHttpUrl = '';
    const result = await nap.sendAction('send_group_msg', { group_id: '456', message: [{ type: 'record', data: { file: 'base64://test' } }] });
    assert.equal(result.status, 'sent');
    assert.equal(result.transport, 'ws');
    assert.equal(result.messageId, 9);
    assert.equal(socket.sent.length, 1);
    assert.equal(socket.sent[0].action, 'send_group_msg');
    assert.equal(httpSends.length, 0);
  }, { ws: (socket, frame) => queueMicrotask(() => reply(socket, frame, { status: 'ok', retcode: 0, data: { message_id: 9 } })) });
});

test('HTTP acknowledgement loss never replays over WS that opens after dispatch', async () => {
  const dispatched = Promise.withResolvers();
  const response = Promise.withResolvers();
  await withNap(async ({ nap, openWs, httpSends }) => {
    const pending = nap.sendAction('send_private_msg', { user_id: '123', message: 'once' });
    await dispatched.promise;
    const socket = await openWs();
    response.reject(new Error('connection reset after the server sent the message'));
    const result = await pending;
    assert.equal(result.status, 'unknown');
    assert.equal(httpSends.length, 1);
    assert.equal(socket.sent.length, 0);
  }, { http: () => { dispatched.resolve(); return response.promise; } });
});

test('HTTP deadline and cancellation after dispatch are unknown, not definite failure', async () => {
  const http = (_action, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  await withNap(async ({ nap, httpSends }) => {
    const timed = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' }, { timeoutMs: 5 });
    assert.equal(timed.status, 'unknown');
    assert.equal(timed.code, 'SEND_TIMEOUT');
    const controller = new AbortController();
    const pending = nap.sendAction('send_private_msg', { user_id: '123', message: 'test' }, { signal: controller.signal });
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, 'unknown');
    assert.equal(cancelled.code, 'SEND_CANCELLED');
    assert.equal(httpSends.length, 2);
  }, { http });
});

test('WS disconnect after dispatch is unknown and never falls back to HTTP', async () => {
  await withNap(async ({ nap, openWs, httpSends }) => {
    const socket = await openWs();
    const result = await nap.sendAction('send_group_msg', { group_id: '456', message: 'once' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'WS_DISCONNECTED');
    assert.equal(socket.sent.length, 1);
    assert.equal(httpSends.length, 0);
  }, { ws: socket => queueMicrotask(() => socket.close()) });
});

test('WS timeout ignores a late success reply and does not resend', async () => {
  await withNap(async ({ nap, openWs, httpSends }) => {
    const socket = await openWs();
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'once' }, { timeoutMs: 5 });
    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'SEND_TIMEOUT');
    reply(socket, socket.sent[0], { status: 'ok', retcode: 0, data: { message_id: 9 } });
    assert.equal(socket.sent.length, 1);
    assert.equal(httpSends.length, 0);
  });
});

test('WS cancellation after dispatch is unknown', async () => {
  await withNap(async ({ nap, openWs }) => {
    const socket = await openWs();
    const controller = new AbortController();
    const pending = nap.sendAction('send_private_msg', { user_id: '123', message: 'once' }, { signal: controller.signal });
    controller.abort();
    const result = await pending;
    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'SEND_CANCELLED');
    assert.equal(socket.sent.length, 1);
  });
});

test('WS malformed envelopes and unreadable frames remain unknown', async () => {
  for (const response of [
    { data: { message_id: 9 } }, { status: 'ok', retcode: 0, data: {} },
    { status: 'ok', retcode: 0, data: { message_id: '9' } },
  ]) {
    await withNap(async ({ nap, openWs, httpSends }) => {
      await openWs();
      const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
      assert.equal(result.status, 'unknown');
      assert.equal(httpSends.length, 0);
    }, { ws: (socket, frame) => queueMicrotask(() => reply(socket, frame, response)) });
  }
  await withNap(async ({ nap, openWs }) => {
    await openWs();
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' }, { timeoutMs: 5 });
    assert.equal(result.status, 'unknown');
    assert.equal(result.code, 'SEND_TIMEOUT');
  }, { ws: socket => queueMicrotask(() => socket.onmessage({ data: 'not-json' })) });
});

test('invalid envelopes, non-JSON, and missing message IDs cannot count as successful sends', async () => {
  const responses = [
    () => new Response('not-json'), () => ok({}), () => ok({ message_id: '9' }),
    () => new Response(JSON.stringify({ status: 'ok', data: { message_id: 9 } })),
    () => new Response(JSON.stringify({ status: 'ok', retcode: 1, data: { message_id: 9 } })),
    () => new Response(JSON.stringify({ status: 'async', retcode: 1, data: {} })),
    () => new Response(JSON.stringify({ status: 'failed', retcode: 1200, message: { unexpected: true } })),
    () => new Response(JSON.stringify(null)),
  ];
  for (const http of responses) {
    await withNap(async ({ nap, httpSends }) => {
      const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
      assert.equal(result.status, 'unknown');
      assert.equal(typeof result.message, 'string');
      assert.equal(httpSends.length, 1);
    }, { http });
  }
});

test('valid integer message_id zero is not lost through a truthiness check', async () => {
  await withNap(async ({ nap }) => {
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
    assert.equal(result.status, 'sent');
    assert.equal(result.messageId, 0);
  }, { http: () => ok({ message_id: 0 }) });
});

test('runtime failure retcodes 200 and 1200 remain unknown and preserve provider details', async () => {
  const envelope = { status: 'failed', retcode: 200, data: null, message: 'kernel acknowledgement timed out' };
  await withNap(async ({ nap }) => {
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.response, envelope);
  }, { http: () => new Response(JSON.stringify(envelope)) });
  await withNap(async ({ nap, openWs, httpSends }) => {
    await openWs();
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.response.retcode, 1200);
    assert.equal(httpSends.length, 0);
  }, { ws: (socket, frame) => queueMicrotask(() => reply(socket, frame, { ...envelope, retcode: 1200 })) });
});

test('HTTP server errors cannot become success even when their body claims success', async () => {
  await withNap(async ({ nap, httpSends }) => {
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
    assert.equal(result.status, 'unknown');
    assert.equal(result.httpStatus, 500);
    assert.equal(result.response.data.message_id, 9);
    assert.equal(httpSends.length, 1);
  }, { http: () => new Response(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 9 } }), { status: 500 }) });
});

test('known pre-dispatch rejections are failed and are not retried', async () => {
  for (const http of [
    () => new Response('token rejected', { status: 403 }),
    () => new Response(JSON.stringify({ status: 'failed', retcode: 400, data: null, message: 'invalid parameters' })),
  ]) {
    await withNap(async ({ nap, httpSends }) => {
      const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
      assert.equal(result.status, 'failed');
      assert.equal(httpSends.length, 1);
    }, { http });
  }
  await withNap(async ({ nap, openWs, httpSends }) => {
    await openWs();
    const result = await nap.sendAction('send_private_msg', { user_id: '123', message: 'test' });
    assert.equal(result.status, 'failed');
    assert.equal(httpSends.length, 0);
  }, { ws: (socket, frame) => queueMicrotask(() => reply(socket, frame, { status: 'failed', retcode: 1400, data: null })) });
});

test('file uploads accept a confirmed nullable file_id but require the field', async () => {
  for (const action of ['upload_private_file', 'upload_group_file']) {
    for (const fileId of [null, 'file-123']) {
      await withNap(async ({ nap }) => {
        const result = await nap.sendAction(action, { user_id: '123', group_id: '456', file: '/tmp/test.txt', name: 'test.txt' });
        assert.equal(result.status, 'sent');
        assert.equal(result.fileId, fileId);
      }, { http: () => ok({ file_id: fileId }) });
    }
    await withNap(async ({ nap }) => {
      const result = await nap.sendAction(action, { user_id: '123', group_id: '456', file: '/tmp/test.txt', name: 'test.txt' });
      assert.equal(result.status, 'unknown');
    }, { http: () => ok({}) });
  }
});

test('local invalid input and cancellation before dispatch send nothing', async () => {
  await withNap(async ({ nap, httpSends }) => {
    const cancelled = AbortSignal.abort();
    for (const args of [
      ['unsupported', {}], ['send_private_msg', null], ['send_private_msg', {}, null],
      ['send_private_msg', {}, { timeoutMs: 0 }], ['send_private_msg', {}, { signal: false }],
      ['send_private_msg', {}, { signal: cancelled }],
    ]) assert.equal((await nap.sendAction(...args)).status, 'failed');
    const circular = {}; circular.self = circular;
    assert.equal((await nap.sendAction('send_private_msg', circular)).status, 'failed');
    assert.equal(httpSends.length, 0);
  });
});
