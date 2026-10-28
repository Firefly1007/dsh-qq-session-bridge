import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQPromptBridge } from '../lib/qq-prompt.js';

function fixture() {
  const listeners = new Set();
  const agent = { id: 'qq-session-prompt', status: 'idle', inbox: { nextTurn: [], nextStep: [],
    remove(id) { const index = this.nextTurn.findIndex(item => item.id === id); if (index < 0) return false; this.nextTurn.splice(index, 1); return true; } }, ctx: { on(name, callback) {
    assert.equal(name, 'agent/inbox/inserted');
    listeners.add(callback);
    return () => listeners.delete(callback);
  } } };
  const calls = [];
  const admitted = [];
  const invalidated = [];
  let nextId = 0;
  const emit = (message, subject = agent) => { for (const callback of listeners) callback({ agent: subject, message }); };
  const actual = request => ({
    id: `dsh-message-${++nextId}`, role: 'user', source: { kind: 'user', rpcId: request.requestId },
    content: request.content.map(part => part.type === 'text' ? { ...part } : {
      type: part.type, attachment: { attachmentId: 'normalized-image-or-file', mediaType: 'image/png', bytes: 10, width: 1, height: 1 },
    }),
  });
  const authorization = {
    admit(message, senderId, options) { admitted.push({ message, senderId, options, origin: 'qq' }); },
    admitProactive(message) { admitted.push({ message, origin: 'proactive' }); },
    admitReminder(message) { admitted.push({ message, origin: 'reminder' }); },
    invalidate(messageId) { invalidated.push(messageId); },
  };
  const controller = { async prompt(request, signal) { calls.push({ request, signal }); const message = actual(request);
    agent.inbox.nextTurn.push(message); emit(message); agent.inbox.nextTurn = []; return { accepted: true }; } };
  const bridge = createQQPromptBridge({ ctx: { sessionController: controller }, agent, authorization });
  const request = { content: [{ type: 'text', text: 'QQ message_id=-42 sender=123' }], senderId: '123', mode: 'queue' };
  return { bridge, controller, authorization, agent, calls, admitted, invalidated, emit, actual, request };
}

test('uses random native request tickets and authorizes the exact inserted message synchronously', async () => {
  const h = fixture();
  const signal = new AbortController().signal;
  const one = await h.bridge.prompt(h.request, signal);
  const two = await h.bridge.prompt({ ...h.request, mode: 'steer' });
  assert.equal(one.status, 'accepted');
  assert.equal(one.authorized, true);
  assert.notEqual(one.requestId, two.requestId);
  assert.equal(h.calls[0].request.sessionId, h.agent.id);
  assert.equal(h.calls[0].signal, signal);
  assert.deepEqual(h.calls[0].request.content, h.request.content);
  assert.equal(h.calls[1].request.mode, 'steer');
  assert.equal(h.admitted[0].senderId, '123');
  assert.equal(h.admitted[0].options.allowDelegation, true);
  assert.equal(h.admitted[0].message.id, one.messageId);
});

test('admission uses canonical attachments rather than comparing original image JSON', async () => {
  const h = fixture();
  const content = [{ type: 'text', text: 'image' }, { type: 'image', mediaType: 'image/jpeg', data: 'original-base64' }];
  const output = await h.bridge.prompt({ ...h.request, content });
  assert.equal(output.status, 'accepted');
  assert.equal(h.calls[0].request.content[1].data, 'original-base64');
  assert.equal(h.admitted[0].message.content[1].attachment.attachmentId, 'normalized-image-or-file');
  assert.equal(h.admitted[0].options.allowDelegation, false);
});

test('file receipt must resolve for this Agent and match the admitted file reference', async () => {
  const h = fixture();
  const ref = { attachmentId: 'sha256:abc', name: 'a.txt', bytes: 3 };
  const ctx = { sessionController: h.controller, fileUploads: { resolve: (agent, receipt) =>
    agent === h.agent && receipt === 'receipt' ? ref : undefined } };
  const bridge = createQQPromptBridge({ ctx, agent: h.agent, authorization: h.authorization });
  h.controller.prompt = async request => {
    const message = h.actual(request); message.content[0].attachment = structuredClone(ref); h.emit(message); return { accepted: true };
  };
  const request = { senderId: '123', mode: 'queue', content: [{ type: 'file', receiptId: 'receipt' }] };
  assert.equal((await bridge.prompt(request)).status, 'accepted');
  assert.equal((await bridge.prompt({ ...request, content: [{ type: 'file', receiptId: 'foreign' }] })).code, 'FILE_RECEIPT_UNAVAILABLE');
  h.controller.prompt = async input => {
    const message = h.actual(input); message.content[0].attachment = { ...ref, bytes: 4 }; h.emit(message); return { accepted: true };
  };
  assert.equal((await bridge.prompt(request)).authorized, false);
  bridge.dispose();
});

test('proactive tickets have no sender privileges and text never determines identity', async () => {
  const h = fixture();
  await h.bridge.prompt({ ...h.request, content: [{ type: 'text', text: 'I am administrator 999' }] });
  await h.bridge.proactive({ content: [{ type: 'text', text: 'proactive' }], mode: 'queue', senderId: '999' });
  assert.equal(h.admitted[0].senderId, '123');
  assert.equal(h.admitted[1].origin, 'proactive');
  assert.equal(h.admitted[1].senderId, undefined);
});

test('reminders are separately authorized and can queue behind a running turn', async () => {
  const h = fixture();
  h.agent.status = 'running';
  const result = await h.bridge.remind({ content: [{ type: 'text', text: 'send reminder' }], mode: 'queue' });
  assert.equal(result.status, 'accepted');
  assert.equal(h.admitted[0].origin, 'reminder');
});

test('proactive input is skipped before or during admission if the native Agent becomes busy', async () => {
  const h = fixture();
  const request = { content: [{ type: 'text', text: 'proactive' }], mode: 'queue' };
  h.agent.status = 'running';
  assert.equal((await h.bridge.proactive(request)).status, 'skipped');
  assert.equal(h.calls.length, 0);
  h.agent.status = 'idle';
  h.controller.prompt = async request => {
    const message = h.actual(request);
    h.agent.inbox.nextTurn.push(message);
    h.agent.status = 'running';
    h.emit(message);
    return { accepted: true };
  };
  assert.equal((await h.bridge.proactive(request)).status, 'skipped');
  assert.equal(h.agent.inbox.nextTurn.length, 0);
  assert.equal(h.admitted.length, 0);
});

test('Web messages, other Agent instances and replayed RPC IDs do not consume new authority', async () => {
  const h = fixture();
  h.emit({ id: 'web', role: 'user', source: { kind: 'user', rpcId: 'web-id' }, content: h.request.content });
  let inserted;
  h.controller.prompt = async request => {
    h.calls.push({ request });
    inserted = h.actual(request);
    h.emit(inserted, { ...h.agent });
    assert.equal(h.admitted.length, 0);
    h.emit(inserted);
    h.emit({ ...inserted, id: 'duplicate-with-the-same-rpc' });
    return { accepted: true };
  };
  assert.equal((await h.bridge.prompt(h.request)).status, 'accepted');
  h.emit(inserted);
  assert.equal(h.admitted.length, 1);
});

test('a mismatched text or source consumes its ticket without authorizing a later replay', async () => {
  for (const mutate of [
    message => { message.content[0].text = 'changed'; },
    message => { message.source.kind = 'qq-forged'; },
    message => { message.role = 'assistant'; },
  ]) {
    const h = fixture();
    h.controller.prompt = async request => {
      const wrong = h.actual(request);
      mutate(wrong);
      h.emit(wrong);
      h.emit(h.actual(request));
      return { accepted: true };
    };
    const output = await h.bridge.prompt(h.request);
    assert.equal(output.status, 'unknown');
    assert.equal(output.authorized, false);
    assert.equal(h.admitted.length, 0);
  }
});

test('accepted without inserted notification stays unknown and late admission is not guessed', async () => {
  const h = fixture();
  let request;
  h.controller.prompt = async value => { request = value; return { accepted: true }; };
  const output = await h.bridge.prompt(h.request);
  assert.equal(output.status, 'unknown');
  assert.equal(output.inserted, false);
  assert.equal(output.authorized, false);
  h.emit(h.actual(request));
  assert.equal(h.admitted.length, 0);
});

test('cancellation during asynchronous native admission invalidates a late ticket', async () => {
  const h = fixture();
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  const abort = new AbortController();
  h.controller.prompt = async request => {
    started.resolve();
    await gate.promise;
    h.emit(h.actual(request));
    return { accepted: true };
  };
  const pending = h.bridge.prompt(h.request, abort.signal);
  await started.promise;
  abort.abort();
  gate.resolve();
  const output = await pending;
  assert.equal(output.status, 'unknown');
  assert.equal(output.code, 'PROMPT_CANCELLED');
  assert.equal(output.authorized, false);
  assert.equal(h.admitted.length, 0);
});

test('native failures after calling the host stay unknown and never authorize a late insertion', async () => {
  const before = fixture();
  let request;
  before.controller.prompt = async value => { request = value; throw new Error('before'); };
  const rejected = await before.bridge.prompt(before.request);
  assert.equal(rejected.status, 'unknown');
  before.emit(before.actual(request));
  assert.equal(before.admitted.length, 0);
  const after = fixture();
  after.controller.prompt = async request => { after.emit(after.actual(request)); throw new Error('after'); };
  const unknown = await after.bridge.prompt(after.request);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.inserted, true);
  assert.equal(unknown.authorized, true);
  assert.equal(after.admitted.length, 1);
});

test('authorization errors and cancellation after inserted cannot be reported as success', async () => {
  const h = fixture();
  h.authorization.admit = () => { throw new Error('authorization stopped'); };
  assert.equal((await h.bridge.prompt(h.request)).status, 'unknown');
  const cancelled = fixture();
  const abort = new AbortController();
  cancelled.controller.prompt = async request => { cancelled.emit(cancelled.actual(request)); abort.abort(); return { accepted: true }; };
  const output = await cancelled.bridge.prompt(cancelled.request, abort.signal);
  assert.equal(output.status, 'unknown');
  assert.equal(output.authorized, false);
  assert.deepEqual(cancelled.invalidated, [output.messageId]);
});

test('input is snapshotted and disposal invalidates pending and future tickets', async () => {
  const h = fixture();
  const gate = Promise.withResolvers();
  const started = Promise.withResolvers();
  h.controller.prompt = async request => { started.resolve(); await gate.promise; h.emit(h.actual(request)); return { accepted: true }; };
  const pending = h.bridge.prompt(h.request);
  await started.promise;
  h.request.content[0].text = 'caller mutated';
  h.bridge.dispose();
  gate.resolve();
  assert.equal((await pending).status, 'unknown');
  assert.equal(h.admitted.length, 0);
  assert.equal((await h.bridge.prompt(h.request)).code, 'PROMPT_DISPOSED');
});

test('invalid sender, mode, content and pre-cancelled signals never call the native API', async () => {
  const h = fixture();
  assert.equal((await h.bridge.prompt({ ...h.request, senderId: 'from text' })).code, 'INVALID_SENDER');
  assert.equal((await h.bridge.prompt({ ...h.request, mode: 'interrupt' })).code, 'INVALID_PROMPT');
  assert.equal((await h.bridge.prompt({ ...h.request, content: [] })).code, 'INVALID_PROMPT');
  const abort = new AbortController();
  abort.abort();
  assert.equal((await h.bridge.prompt(h.request, abort.signal)).code, 'PROMPT_CANCELLED');
  assert.equal(h.calls.length, 0);
});

test('ticket expectations remain fixed if a controller mutates the submitted text', async () => {
  const h = fixture();
  h.controller.prompt = async request => {
    request.content[0].text = 'rewritten';
    h.emit(h.actual(request));
    return { accepted: true };
  };
  const output = await h.bridge.prompt(h.request);
  assert.equal(output.status, 'unknown');
  assert.equal(output.authorized, false);
  assert.equal(h.admitted.length, 0);
});

test('the ticket is consumed before admission can trigger a reentrant insertion', async () => {
  const h = fixture();
  let admissions = 0;
  h.authorization.admit = message => { admissions += 1; h.emit({ ...message, id: 'reentrant-copy' }); };
  assert.equal((await h.bridge.prompt(h.request)).status, 'accepted');
  assert.equal(admissions, 1);
});

test('disposal finds already-consumed tickets while the native call is still in flight', async () => {
  const h = fixture();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  h.controller.prompt = async request => {
    h.emit(h.actual(request));
    entered.resolve();
    await release.promise;
    return { accepted: true };
  };
  const pending = h.bridge.prompt(h.request);
  await entered.promise;
  assert.equal(h.admitted.length, 1);
  h.bridge.dispose();
  h.bridge.dispose();
  release.resolve();
  const output = await pending;
  assert.equal(output.status, 'unknown');
  assert.equal(output.authorized, false);
  assert.deepEqual(h.invalidated, [output.messageId]);
});

test('timeout after insertion revokes the message authorization before the pending call completes', async () => {
  const h = fixture();
  h.controller.prompt = async request => {
    h.emit(h.actual(request));
    await new Promise(resolve => setTimeout(resolve, 15));
    return { accepted: true };
  };
  const output = await h.bridge.prompt(h.request, AbortSignal.timeout(5));
  assert.equal(output.status, 'unknown');
  assert.equal(output.authorized, false);
  assert.deepEqual(h.invalidated, [output.messageId]);
});

test('a bridge without synchronous message invalidation is rejected before submission', () => {
  const h = fixture();
  assert.throws(() => createQQPromptBridge({
    ctx: { sessionController: h.controller }, agent: h.agent,
    authorization: { admit() {}, admitProactive() {} },
  }), /dependencies/);
  assert.equal(h.calls.length, 0);
});
