import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQAuthorization } from '../lib/qq-authorization.js';

function harness(options = {}) {
  const { history = [], ...configuration } = options;
  const listeners = new Map();
  const guards = [];
  const agent = {
    session: { snapshotEvents: () => history }, status: 'idle',
    ctx: {
      on(name, listener) {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(listener);
        return () => listeners.get(name).delete(listener);
      },
      tools: { guard(listener) { guards.push(listener); } },
    },
  };
  const authorization = createQQAuthorization({ agent, controlTools: ['delegate', 'continue_child'], administratorIds: ['1'], ...configuration });
  function event(type, data = {}, session = agent.session) {
    for (const listener of listeners.get('session/event') || []) listener(session, { type, data });
  }
  async function step(messages, turn = 1, number = 1) {
    agent.status = 'running';
    for (const message of messages) claim(message);
    event('step/start', { turn, step: number });
    for (const message of messages) event('user/message', message);
  }
  function claim(message) {
    for (const listener of listeners.get('agent/inbox/claimed') || []) listener({ agent, message });
  }
  function invoke(name = 'delegate', caller = agent) {
    return guards.map(guard => guard({ name, agent: caller })).find(Boolean);
  }
  function message(id, sender = '1') {
    return { id, role: 'user', source: { kind: 'qq', senderId: sender }, content: [{ type: 'text', text: 'task' }] };
  }
  return { agent, authorization, event, step, claim, invoke, message, listeners };
}

test('delegation controls must be explicit and identities valid', () => {
  for (const controlTools of [undefined, [], [''], [' delegate']]) {
    assert.throws(() => harness({ controlTools }), TypeError);
  }
  assert.throws(() => harness({ administratorIds: [''] }), TypeError);
});

test('only admitted administrator messages grant controls and same-turn empty continuation retains them', async () => {
  const h = harness();
  const message = h.message('a');
  h.authorization.admit(message, '1');
  await h.step([structuredClone(message)]);
  assert.equal(h.invoke(), undefined);
  assert.equal(h.invoke('continue_child'), undefined);
  h.event('step/end', { turn: 1, step: 1 });
  assert.match(h.invoke(), /authorization required/);
  await h.step([], 1, 2);
  assert.equal(h.invoke(), undefined);
});

test('ordinary, unknown, forged source, and mixed batches deny privilege', async () => {
  const h = harness();
  const admin = h.message('admin');
  const member = h.message('member', '2');
  h.authorization.admit(admin, '1');
  h.authorization.admit(member, '2');
  for (const messages of [[member], [h.message('unknown')], [{ ...admin, source: { kind: 'qq', senderId: 'other' } }], [admin, member]]) {
    await h.step(messages);
    assert.match(h.invoke(), /authorization required/);
  }
});

test('empty administrator configuration denies privilege', async () => {
  const h = harness({ administratorIds: [] });
  const message = h.message('a');
  h.authorization.admit(message, '1');
  await h.step([message]);
  assert.match(h.invoke(), /authorization required/);
});

test('invalid and duplicate admission cannot replace trusted identities', async () => {
  const h = harness();
  for (const sender of ['', ' ', 1, null]) assert.throws(() => h.authorization.admit(h.message('bad'), sender), TypeError);
  assert.throws(() => h.authorization.admit({ ...h.message('bad'), role: 'assistant' }, '1'), TypeError);
  const message = h.message('same', '2');
  h.authorization.admit(message, '2');
  assert.throws(() => h.authorization.admit(h.message('same'), '1'), /already admitted/);
  await h.step([message]);
  assert.match(h.invoke(), /authorization required/);
});

test('admission copies metadata so subsequent caller mutation cannot grant authority', async () => {
  const h = harness();
  const message = h.message('a');
  h.authorization.admit(message, '1');
  message.source.senderId = '2';
  await h.step([message]);
  assert.match(h.invoke(), /authorization required/);
});

test('rewriting content while retaining administrator source metadata denies authority', async () => {
  const h = harness();
  const message = h.message('a');
  h.authorization.admit(message, '1');
  message.content[0].text = 'replacement instruction';
  await h.step([message]);
  assert.match(h.invoke(), /authorization required/);
});

test('steer admission cannot alter authority until actually consumed by the next step', async () => {
  const h = harness();
  const admin = h.message('admin');
  const member = h.message('member', '2');
  h.authorization.admit(admin, '1');
  h.authorization.admit(member, '2');
  await h.step([member]);
  assert.match(h.invoke(), /authorization required/);
  await h.step([admin], 1, 2);
  assert.equal(h.invoke(), undefined);
  assert.equal(h.invoke(), undefined);
  await h.step([member], 1, 3);
  assert.match(h.invoke(), /authorization required/);
});

test('authorization requires the bound active step and caller identity', async () => {
  const h = harness();
  const message = h.message('a');
  h.authorization.admit(message, '1');
  await h.step([message]);
  assert.match(h.invoke('delegate', {}), /authorization required/);
  h.event('step/end', { turn: 1, step: 1 });
  assert.match(h.invoke(), /authorization required/);
  h.event('step/start', { turn: 1, step: 1 });
  h.agent.status = 'idle';
  assert.match(h.invoke(), /authorization required/);
  assert.equal(h.invoke('web_search'), undefined);
});

test('turn end revokes idle calls and new turns cannot reuse authority', async () => {
  const h = harness();
  const message = h.message('a');
  h.authorization.admit(message, '1');
  await h.step([message]);
  h.event('turn/end', { turn: 1 });
  assert.match(h.invoke(), /authorization required/);
  h.event('turn/start', { turn: 2 });
  await h.step([], 2, 1);
  assert.match(h.invoke(), /authorization required/);
});

test('unrelated sessions do not alter the bound active step', async () => {
  const h = harness();
  const message = h.message('a');
  h.authorization.admit(message, '1');
  await h.step([message]);
  h.event('turn/end', {}, {});
  assert.equal(h.invoke(), undefined);
});

test('dispose removes listeners, clears admission, and leaves a rejecting guard', async () => {
  const h = harness();
  const message = h.message('a');
  h.authorization.admit(message, '1');
  await h.step([message]);
  h.authorization.dispose();
  h.authorization.dispose();
  assert.match(h.invoke(), /authorization required/);
  assert.throws(() => h.authorization.admit(h.message('new'), '1'), /disposed/);
  assert.equal(h.listeners.get('session/event').size, 0);
  assert.equal(h.listeners.get('agent/inbox/claimed').size, 0);
  assert.equal(h.listeners.get('agent/inbox/discarded').size, 0);
  await h.step([message]);
  assert.match(h.invoke(), /authorization required/);
});

test('outer pre-step replacements cannot inherit candidate administrator authority', () => {
  for (const replacement of ['member', 'unknown', 'runtime-context']) {
    const h = harness();
    const admin = h.message('admin');
    h.authorization.admit(admin, '1');
    h.agent.status = 'running';
    h.claim(admin);
    h.event('step/start', { turn: 1, step: 1 });
    h.event('user/message', { ...h.message(replacement, '2'), source: { kind: replacement } });
    assert.match(h.invoke(), /authorization required/);
  }
});

test('runtime snapshots cannot satisfy a dropped unknown input alongside an administrator', () => {
  const h = harness();
  const admin = h.message('admin');
  const unknown = h.message('unknown', '2');
  h.authorization.admit(admin, '1');
  h.agent.status = 'running';
  h.claim(admin);
  h.claim(unknown);
  h.event('step/start', { turn: 1, step: 1 });
  h.event('user/message', admin);
  h.event('user/message', { id: 'snapshot', source: { kind: 'runtime-context' } });
  assert.match(h.invoke(), /authorization required/);
  h.event('step/end', { turn: 1, step: 1 });
  h.event('step/start', { turn: 1, step: 2 });
  assert.match(h.invoke(), /authorization required/);
});

test('DSH runtime snapshots coexist with valid QQ input but never grant by themselves', async () => {
  const h = harness();
  const admin = h.message('admin');
  h.authorization.admit(admin, '1');
  await h.step([admin]);
  h.event('user/message', { id: 'snapshot', source: { kind: 'runtime-context' } });
  assert.equal(h.invoke(), undefined);
  assert.throws(() => h.authorization.admit({ ...admin, id: 'forged-runtime', source: { kind: 'runtime-context' } }, '1'), TypeError);
  const empty = harness();
  empty.agent.status = 'running';
  empty.event('step/start', { turn: 1, step: 1 });
  empty.event('user/message', { id: 'snapshot', source: { kind: 'runtime-context' } });
  assert.match(empty.invoke(), /authorization required/);
});

test('replaying a previously consumed administrator message is rejected', async () => {
  const h = harness();
  const admin = h.message('admin');
  h.authorization.admit(admin, '1');
  await h.step([admin]);
  assert.equal(h.invoke(), undefined);
  await h.step([admin], 1, 2);
  assert.match(h.invoke(), /authorization required/);
});

test('trusted QQ members can send only after actual commitment, independently of administrator rights', async () => {
  const h = harness();
  const member = h.message('member', '2');
  h.authorization.admit(member, '2');
  assert.equal(h.authorization.canSend(), false);
  h.agent.status = 'running';
  h.claim(member);
  h.event('step/start', { turn: 1, step: 1 });
  assert.equal(h.authorization.canSend(), false);
  h.event('user/message', structuredClone(member));
  assert.equal(h.authorization.canSend(), true);
  assert.match(h.invoke(), /authorization required/);
});

test('explicit proactive admission permits sending without administrator delegation', async () => {
  const h = harness();
  const proactive = h.message('proactive');
  h.authorization.admitProactive(proactive);
  assert.equal(h.authorization.canSend(), false);
  await h.step([proactive]);
  assert.equal(h.authorization.canSend(), true);
  assert.match(h.invoke(), /authorization required/);
  h.event('step/end', { turn: 1, step: 1 });
  assert.equal(h.authorization.canSend(), false);
  await h.step([], 1, 2);
  assert.equal(h.authorization.canSend(), true);
  assert.match(h.invoke(), /authorization required/);
});

test('turn completion reports trusted origin and a reminder cannot delegate', async () => {
  const completed = [];
  const h = harness({ onTurnEnd: value => completed.push(value) });
  const message = h.message('reminder');
  h.authorization.admitReminder(message);
  await h.step([message]);
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.authorization.canDelegate(), false);
  h.event('step/end', { turn: 1, step: 1 });
  h.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  assert.deepEqual(completed, [{ turn: 1, reason: { kind: 'completed' }, origin: 'reminder', sendable: true }]);
});

test('only the active trusted QQ turn can resolve its own verified file attachment', async () => {
  const h = harness();
  const ref = { attachmentId: 'sha256:abc', name: 'a.txt', bytes: 3 };
  const message = { ...h.message('file'), content: [{ type: 'file', attachment: ref }] };
  h.authorization.admit(message, '2', { allowDelegation: false });
  await h.step([message]);
  const permit = h.authorization.captureSendPermit();
  assert.deepEqual(h.authorization.resolveQQFile(ref.attachmentId, permit), ref);
  assert.equal(h.authorization.resolveQQFile('sha256:other', permit), null);
  assert.equal(h.authorization.resolveQQFile(ref.attachmentId, {}), null);
  h.event('step/end', { turn: 1, step: 1 });
  assert.equal(h.authorization.resolveQQFile(ref.attachmentId, permit), null);
});

test('webpage and forged proactive sources cannot send without explicit bridge admission', async () => {
  for (const source of [{ kind: 'user' }, { kind: 'proactive' }, { kind: 'qq', senderId: '1' }]) {
    const h = harness();
    await h.step([{ ...h.message('unknown'), source }]);
    assert.equal(h.authorization.canSend(), false);
  }
});

test('mixing QQ with webpage or proactive inputs denies sends, while multiple trusted QQ members can send', async () => {
  for (const mixedOrigin of ['webpage', 'proactive', 'qq']) {
    const h = harness();
    const first = h.message('first', '1');
    const second = h.message('second', '2');
    h.authorization.admit(first, '1');
    if (mixedOrigin === 'proactive') h.authorization.admitProactive(second);
    if (mixedOrigin === 'qq') h.authorization.admit(second, '2');
    await h.step([first, second]);
    assert.equal(h.authorization.canSend(), mixedOrigin === 'qq');
    assert.match(h.invoke(), /authorization required/);
  }
});

test('send authority follows consumed steer inputs rather than newly admitted messages', async () => {
  const h = harness();
  const qq = h.message('qq', '2');
  const webpage = { ...h.message('webpage'), source: { kind: 'user' } };
  await h.step([webpage]);
  h.authorization.admit(qq, '2');
  assert.equal(h.authorization.canSend(), false);
  await h.step([qq], 1, 2);
  assert.equal(h.authorization.canSend(), true);
  const proactive = h.message('proactive');
  h.authorization.admitProactive(proactive);
  assert.equal(h.authorization.canSend(), true);
  await h.step([webpage], 1, 3);
  assert.equal(h.authorization.canSend(), false);
});

test('sending is revoked at idle, turn end, new turns, and disposal', async () => {
  const h = harness();
  const qq = h.message('qq');
  h.authorization.admit(qq, '1');
  await h.step([qq]);
  assert.equal(h.authorization.canSend(), true);
  h.agent.status = 'idle';
  assert.equal(h.authorization.canSend(), false);
  h.agent.status = 'running';
  h.event('turn/end', { turn: 1 });
  assert.equal(h.authorization.canSend(), false);
  h.event('turn/start', { turn: 2 });
  await h.step([], 2, 1);
  assert.equal(h.authorization.canSend(), false);
  const next = h.message('next');
  h.authorization.admit(next, '1');
  await h.step([next], 2, 2);
  assert.equal(h.authorization.canSend(), true);
  h.authorization.dispose();
  assert.equal(h.authorization.canSend(), false);
  assert.throws(() => h.authorization.admitProactive(h.message('disposed')), /disposed/);
});

test('proactive admission cannot overwrite identities and changed or replayed snapshots cannot send', async () => {
  const h = harness();
  const proactive = h.message('p');
  h.authorization.admitProactive(proactive);
  assert.throws(() => h.authorization.admit(proactive, '1'), /already admitted/);
  assert.throws(() => h.authorization.admitProactive(proactive), /already admitted/);
  const changed = structuredClone(proactive);
  changed.content[0].text = 'changed';
  await h.step([changed]);
  assert.equal(h.authorization.canSend(), false);
  await h.step([proactive], 1, 2);
  assert.equal(h.authorization.canSend(), false);
});

test('missing claimed input cannot grant sending through a synthetic runtime snapshot', () => {
  const h = harness();
  const qq = h.message('qq');
  h.authorization.admit(qq, '1');
  h.agent.status = 'running';
  h.claim(qq);
  h.claim(h.message('unknown'));
  h.event('step/start', { turn: 1, step: 1 });
  h.event('user/message', qq);
  h.event('user/message', { id: 'runtime', source: { kind: 'runtime-context' } });
  assert.equal(h.authorization.canSend(), false);
});

test('send permits are opaque and bound to one active step even when the next step can also send', async () => {
  const h = harness();
  assert.equal(h.authorization.captureSendPermit(), null);
  const qq = h.message('qq');
  h.authorization.admit(qq, '1');
  await h.step([qq]);
  const permit = h.authorization.captureSendPermit();
  assert.ok(permit);
  assert.ok(Object.isFrozen(permit));
  assert.equal(h.authorization.canSend(permit), true);
  assert.equal(h.authorization.canSend(Object.freeze({})), false);
  assert.equal(h.authorization.canSend(null), false);
  h.event('step/end', { turn: 1, step: 1 });
  assert.equal(h.authorization.canSend(permit), false);
  await h.step([], 1, 2);
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.authorization.canSend(permit), false);
  assert.notEqual(h.authorization.captureSendPermit(), permit);
});

test('turn end and disposal invalidate existing send permits', async () => {
  for (const ending of ['turn', 'dispose']) {
    const h = harness();
    const qq = h.message('qq');
    h.authorization.admit(qq, '1');
    await h.step([qq]);
    const permit = h.authorization.captureSendPermit();
    if (ending === 'dispose') h.authorization.dispose();
    else h.event('turn/end', { turn: 1 });
    assert.equal(h.authorization.canSend(permit), false);
    assert.equal(h.authorization.captureSendPermit(), null);
  }
});

function switchNotice(id, previous = { provider: 'mock', model: 'old' }, selected = { provider: 'mock', model: 'new' }) {
  const from = previous.provider === selected.provider ? previous.model : `${previous.provider}/${previous.model}`;
  const to = previous.provider === selected.provider ? selected.model : `${selected.provider}/${selected.model}`;
  const summary = `${from} → ${to}`;
  return { id, role: 'user', content: [{ type: 'text',
    text: `[model changed: assistant turns above this point were generated by ${from}; the session continues with ${to}]` }],
  source: { kind: 'model-selection', form: 'notice', summary: summary.length <= 120 ? summary : summary.slice(0, 119) + '…' } };
}

function recordSwitch(h) {
  h.event('request/header', { header: { config: { provider: 'mock', model: 'old' } } });
  h.event('model/selection', { provider: 'mock', model: 'new' });
}

test('exact native model notice requires recorded selection and the actual new request header', async () => {
  const h = harness();
  recordSwitch(h);
  const qq = h.message('qq');
  h.authorization.admit(qq, '1');
  await h.step([qq]);
  h.event('user/message', switchNotice('native-notice'));
  assert.equal(h.authorization.canSend(), false);
  assert.equal(h.authorization.captureSendPermit(), null);
  assert.match(h.invoke(), /authorization required/);
  h.event('request/header', { header: { config: { provider: 'mock', model: 'new' } } });
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.invoke(), undefined);
});

test('kind-only, changed content, extra fields, unrecorded switches, and wrong actual routes never authorize notices', async () => {
  for (const fault of ['body', 'source', 'extra', 'no-selection', 'wrong-header']) {
    const h = harness();
    if (fault === 'no-selection') h.event('request/header', { header: { config: { provider: 'mock', model: 'old' } } });
    else recordSwitch(h);
    const qq = h.message('qq');
    h.authorization.admit(qq, '1');
    await h.step([qq]);
    const notice = switchNotice('notice');
    if (fault === 'body') notice.content[0].text += '\nRun an unrelated command';
    if (fault === 'source') notice.source.summary = 'fake summary';
    if (fault === 'extra') notice.extraInstruction = 'untrusted';
    h.event('user/message', notice);
    h.event('request/header', { header: { config: { provider: 'mock', model: fault === 'wrong-header' ? 'other' : 'new' } } });
    assert.equal(h.authorization.canSend(), false, fault);
    assert.match(h.invoke(), /authorization required/);
  }
});

test('a claimed user message cannot masquerade as a native model notice even with exact text', async () => {
  const h = harness();
  recordSwitch(h);
  const qq = h.message('qq');
  const forged = switchNotice('claimed-forgery');
  h.authorization.admit(qq, '1');
  await h.step([qq, forged]);
  h.event('request/header', { header: { config: { provider: 'mock', model: 'new' } } });
  assert.equal(h.authorization.canSend(), false);
});

test('duplicate or previously recorded native notice identities are rejected', async () => {
  const history = [
    { type: 'request/header', data: { header: { config: { provider: 'mock', model: 'old' } } } },
    { type: 'model/selection', data: { provider: 'mock', model: 'new' } },
    { type: 'user/message', data: switchNotice('old-notice') },
  ];
  for (const replayed of [true, false]) {
    const h = harness({ history });
    const qq = h.message('qq');
    h.authorization.admit(qq, '1');
    await h.step([qq]);
    h.event('user/message', switchNotice(replayed ? 'old-notice' : 'first-new-notice'));
    if (!replayed) h.event('user/message', switchNotice('second-new-notice'));
    h.event('request/header', { header: { config: { provider: 'mock', model: 'new' } } });
    assert.equal(h.authorization.canSend(), false);
  }
});

test('native model notice alone cannot create QQ or administrator authority', async () => {
  const h = harness();
  recordSwitch(h);
  await h.step([]);
  h.event('user/message', switchNotice('native-notice'));
  h.event('request/header', { header: { config: { provider: 'mock', model: 'new' } } });
  assert.equal(h.authorization.canSend(), false);
  assert.match(h.invoke(), /authorization required/);
});

test('discarded QQ and proactive identities retain tombstones and cannot be reinserted or readmitted', async () => {
  for (const origin of ['qq', 'proactive']) {
    const h = harness();
    const original = h.message('discarded');
    if (origin === 'qq') h.authorization.admit(original, '1');
    else h.authorization.admitProactive(original);
    for (const listener of h.listeners.get('agent/inbox/discarded')) {
      listener({ agent: h.agent, message: structuredClone(original) });
    }
    assert.throws(() => h.authorization.admit(original, '1'), /already admitted/);
    assert.throws(() => h.authorization.admitProactive(original), /already admitted/);
    await h.step([original]);
    assert.equal(h.authorization.canSend(), false);
    assert.equal(h.authorization.captureSendPermit(), null);
    assert.match(h.invoke(), /authorization required/);
  }
});

test('another Agent discarding the same identity does not revoke this Agent admission', async () => {
  const h = harness();
  const original = h.message('qq');
  h.authorization.admit(original, '1');
  for (const listener of h.listeners.get('agent/inbox/discarded')) listener({ agent: {}, message: original });
  await h.step([original]);
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.invoke(), undefined);
});

test('canDelegate reports only active trusted administrator steps', async () => {
  for (const origin of ['admin', 'member', 'proactive', 'unknown']) {
    const h = harness();
    const message = h.message('input', origin === 'member' ? '2' : '1');
    if (origin === 'admin' || origin === 'member') h.authorization.admit(message, origin === 'member' ? '2' : '1');
    if (origin === 'proactive') h.authorization.admitProactive(message);
    assert.equal(h.authorization.canDelegate(), false);
    await h.step([message]);
    assert.equal(h.authorization.canDelegate(), origin === 'admin');
    h.agent.status = 'idle';
    assert.equal(h.authorization.canDelegate(), false);
    h.event('turn/end', { turn: 1 });
    assert.equal(h.authorization.canDelegate(), false);
  }
});

test('invalidate synchronously revokes the current QQ source, its step permit and delegation', async () => {
  const h = harness();
  const message = h.message('qq');
  h.authorization.admit(message, '1');
  await h.step([message]);
  const permit = h.authorization.captureSendPermit();
  assert.equal(h.authorization.canDelegate(), true);
  assert.equal(h.authorization.invalidate(message.id), true);
  assert.equal(h.authorization.canDelegate(), false);
  assert.equal(h.authorization.canSend(permit), false);
  assert.equal(h.authorization.captureSendPermit(), null);
  assert.match(h.invoke(), /authorization required/);
  assert.throws(() => h.authorization.admit(message, '1'), /already admitted/);
});

test('invalidate also revokes source authority carried into empty continuation steps', async () => {
  const h = harness();
  const message = h.message('qq');
  h.authorization.admit(message, '1');
  await h.step([message]);
  h.event('step/end', { turn: 1, step: 1 });
  await h.step([], 1, 2);
  assert.equal(h.authorization.canSend(), true);
  const permit = h.authorization.captureSendPermit();
  h.authorization.invalidate(message.id);
  assert.equal(h.authorization.canSend(permit), false);
  assert.equal(h.authorization.canDelegate(), false);
});

test('invalidating a queued identity does not rewrite the active source but refuses its eventual consumption', async () => {
  const h = harness();
  const current = h.message('current');
  const queued = h.message('queued');
  h.authorization.admit(current, '1');
  h.authorization.admit(queued, '1');
  await h.step([current]);
  const permit = h.authorization.captureSendPermit();
  assert.equal(h.authorization.invalidate('unknown'), false);
  assert.equal(h.authorization.invalidate(''), false);
  assert.equal(h.authorization.invalidate(queued.id), true);
  assert.equal(h.authorization.canSend(permit), true);
  assert.equal(h.authorization.canDelegate(), true);
  await h.step([queued], 1, 2);
  assert.equal(h.authorization.canSend(), false);
  assert.equal(h.authorization.canDelegate(), false);
});

test('proactive cancellation and invalidation after disposal are safe and never grant authority', async () => {
  const h = harness();
  const message = h.message('proactive');
  h.authorization.admitProactive(message);
  await h.step([message]);
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.authorization.invalidate(message.id), true);
  assert.equal(h.authorization.canSend(), false);
  assert.equal(h.authorization.canDelegate(), false);
  h.authorization.dispose();
  assert.equal(h.authorization.invalidate(message.id), false);
});

test('administrator updates revoke current delegation but preserve sends and evaluate queued input under the new list', async () => {
  const h = harness();
  const current = h.message('current');
  const queued = h.message('queued', '2');
  h.authorization.admit(current, '1');
  h.authorization.admit(queued, '2');
  await h.step([current]);
  const permit = h.authorization.captureSendPermit();
  assert.equal(h.authorization.canDelegate(), true);
  h.authorization.setAdministratorIds(['2']);
  assert.equal(h.authorization.canDelegate(), false);
  assert.equal(h.authorization.canSend(permit), true);
  assert.match(h.invoke(), /authorization required/);
  await h.step([], 1, 2);
  assert.equal(h.authorization.canDelegate(), false);
  await h.step([queued], 1, 3);
  assert.equal(h.authorization.canDelegate(), true);
  assert.equal(h.authorization.canSend(), true);
});

test('invalid administrator updates are atomic and cannot alter the existing decision', async () => {
  const h = harness();
  const message = h.message('qq');
  h.authorization.admit(message, '1');
  await h.step([message]);
  for (const ids of [null, '1', [''], [' 1'], [1]]) {
    assert.throws(() => h.authorization.setAdministratorIds(ids), TypeError);
    assert.equal(h.authorization.canDelegate(), true);
  }
});

test('administrator input arrays are copied and an empty update disables future delegation', async () => {
  const h = harness();
  const ids = ['1'];
  h.authorization.setAdministratorIds(ids);
  ids.push('2');
  const member = h.message('member', '2');
  h.authorization.admit(member, '2');
  await h.step([member]);
  assert.equal(h.authorization.canDelegate(), false);
  h.authorization.setAdministratorIds([]);
  const previousAdmin = h.message('previous-admin');
  h.authorization.admit(previousAdmin, '1');
  await h.step([previousAdmin], 1, 2);
  assert.equal(h.authorization.canDelegate(), false);
  assert.equal(h.authorization.canSend(), true);
});

test('promoting the current sender does not grant delegation until a new trusted input is consumed', async () => {
  const h = harness({ administratorIds: [] });
  const current = h.message('current');
  const next = h.message('next');
  h.authorization.admit(current, '1');
  h.authorization.admit(next, '1');
  await h.step([current]);
  h.authorization.setAdministratorIds(['1']);
  assert.equal(h.authorization.canDelegate(), false);
  assert.equal(h.authorization.canSend(), true);
  await h.step([], 1, 2);
  assert.equal(h.authorization.canDelegate(), false);
  await h.step([next], 1, 3);
  assert.equal(h.authorization.canDelegate(), true);
});

test('trusted QQ inputs with unverified attachment content may send but never delegate or authorize continuation', async () => {
  const h = harness();
  const message = h.message('attachment');
  const options = { allowDelegation: false };
  h.authorization.admit(message, '1', options);
  options.allowDelegation = true;
  await h.step([message]);
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.authorization.canDelegate(), false);
  assert.match(h.invoke(), /authorization required/);
  await h.step([], 1, 2);
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.authorization.canDelegate(), false);
  const next = h.message('verified');
  h.authorization.admit(next, '1');
  await h.step([next], 1, 3);
  assert.equal(h.authorization.canDelegate(), true);
});

test('a mixed batch containing a nondelegating administrator input cannot delegate', async () => {
  const h = harness();
  const text = h.message('text');
  const attachment = h.message('attachment');
  h.authorization.admit(text, '1');
  h.authorization.admit(attachment, '1', { allowDelegation: false });
  await h.step([text, attachment]);
  assert.equal(h.authorization.canSend(), true);
  assert.equal(h.authorization.canDelegate(), false);
});

test('delegation admission options are validated before preserving an identity', async () => {
  for (const options of [null, false, [], { allowDelegation: 'false' }, { allowDelegation: 0 }, { extra: true }]) {
    const h = harness();
    const message = h.message('message');
    assert.throws(() => h.authorization.admit(message, '1', options), TypeError);
    h.authorization.admit(message, '1', { allowDelegation: true });
    await h.step([message]);
    assert.equal(h.authorization.canDelegate(), true);
  }
});
