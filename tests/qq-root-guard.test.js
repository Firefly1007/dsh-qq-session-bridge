import test from 'node:test';
import assert from 'node:assert/strict';
import { QQ_SESSION_PREFIX, isQQSessionId, createQQRootGuard, getQQHostGuard } from '../lib/qq-root-guard.js';

function agent(id = `${QQ_SESSION_PREFIX}123`, header = {}) {
  return { id, ctx: { preset: 'bot' }, session: { header: { id, ...header } } };
}

function harness() {
  const guards = [];
  let unregistered = 0;
  let presets = { composedPreset: scope => scope.preset };
  const ctx = { tools: { guard(callback) { guards.push(callback); return () => { unregistered += 1; }; } }, get: () => presets };
  const guard = createQQRootGuard(ctx);
  return {
    guard, guards,
    denied(subject, name = 'read') { return guards[0]({ agent: subject, name }); },
    removePresets() { presets = undefined; },
    unregistered: () => unregistered,
  };
}

test('installs a host guard synchronously and denies a root before initialization', () => {
  const h = harness();
  assert.equal(h.guards.length, 1);
  assert.ok(h.denied(agent()));
  assert.equal(h.denied(agent('normal-dsh-session')), undefined);
  assert.equal(h.denied(undefined), undefined);
  assert.equal(isQQSessionId(QQ_SESSION_PREFIX), false);
  assert.equal(isQQSessionId(`${QQ_SESSION_PREFIX}123`), true);
});

test('preset changes or missing registry deny even previously allowed tools', () => {
  const h = harness();
  const root = agent();
  h.guard.setPolicy(root, ['web']);
  assert.equal(h.denied(root, 'web'), undefined);
  root.ctx.preset = 'standard';
  assert.match(h.denied(root, 'web'), /not in bot mode/);
  root.ctx.preset = 'bot';
  h.removePresets();
  assert.match(h.denied(root, 'web'), /not in bot mode/);
});

test('ready policy allows only named tools and snapshots the caller list', () => {
  const h = harness();
  const root = agent();
  const names = ['web'];
  h.guard.setPolicy(root, names);
  names.push('shell');
  assert.equal(h.denied(root, 'web'), undefined);
  assert.ok(h.denied(root, 'shell'));
  assert.ok(h.denied(root, 'other'));
});

test('a different Agent instance with the same id is denied until separately initialized', () => {
  const h = harness();
  const first = agent();
  const restored = agent();
  h.guard.setPolicy(first, ['web']);
  assert.equal(h.denied(first, 'web'), undefined);
  assert.ok(h.denied(restored, 'web'));
  h.guard.setPolicy(restored, ['search']);
  assert.equal(h.denied(restored, 'search'), undefined);
  assert.ok(h.denied(restored, 'web'));
});

test('revocation, clearing and stop remain fail closed without unregistering the host guard', () => {
  const h = harness();
  const first = agent();
  const second = agent(`${QQ_SESSION_PREFIX}456`);
  h.guard.setPolicy(first, ['web']);
  h.guard.setPolicy(second, ['web']);
  h.guard.revoke(first);
  assert.ok(h.denied(first, 'web'));
  assert.equal(h.denied(second, 'web'), undefined);
  h.guard.clear();
  assert.ok(h.denied(second, 'web'));
  h.guard.setPolicy(first, ['web']);
  h.guard.stop();
  h.guard.clear();
  assert.ok(h.denied(first, 'web'));
  assert.throws(() => h.guard.setPolicy(first, ['web']), /stopped/);
  assert.equal(h.unregistered(), 0);
});

test('a host reuses its guard after bridge disable and starts with no granted policy', () => {
  const callbacks = [];
  const host = { tools: { guard: callback => callbacks.push(callback) },
    get: () => ({ composedPreset: scope => scope.preset }) };
  const first = getQQHostGuard(host);
  const root = agent();
  first.setPolicy(root, ['web']);
  assert.equal(callbacks[0]({ agent: root, name: 'web' }), undefined);
  first.clear();
  assert.ok(callbacks[0]({ agent: root, name: 'web' }));
  assert.equal(getQQHostGuard(host), first);
  assert.equal(callbacks.length, 1);
  first.setPolicy(root, ['web']);
  assert.equal(callbacks[0]({ agent: root, name: 'web' }), undefined);
});

test('normal DSH Agents and subagents remain outside the QQ root policy', () => {
  const h = harness();
  const child = agent('subagent-123', { origin: 'subagent', parentSession: `${QQ_SESSION_PREFIX}parent`, delegationDepth: 1 });
  assert.equal(h.denied(child, 'shell'), undefined);
  assert.equal(h.denied(agent('normal-root'), 'shell'), undefined);
  assert.throws(() => h.guard.setPolicy(child, ['shell']), /QQ root/);
  h.guard.stop();
  assert.equal(h.denied(child, 'shell'), undefined);
});

test('QQ namespace and abnormal header lineage cannot be used to bypass policy', () => {
  const h = harness();
  for (const subject of [
    agent(`${QQ_SESSION_PREFIX}root`, { origin: 'subagent' }),
    agent(`${QQ_SESSION_PREFIX}root`, { origin: 'subagent', parentSession: 'parent', delegationDepth: 1 }),
    agent(`${QQ_SESSION_PREFIX}root`, { parentSession: 'parent' }),
    agent(`${QQ_SESSION_PREFIX}root`, { delegationDepth: 1 }),
    agent(`${QQ_SESSION_PREFIX}root`, { isSeeded: true }),
    agent(QQ_SESSION_PREFIX),
    agent(`${QQ_SESSION_PREFIX}root`, { id: 'normal' }),
    agent('normal', { id: `${QQ_SESSION_PREFIX}root` }),
    { id: `${QQ_SESSION_PREFIX}root` },
  ]) {
    assert.ok(h.denied(subject, 'web'));
    assert.throws(() => h.guard.setPolicy(subject, ['web']), /QQ root/);
  }
  assert.throws(() => h.guard.setPolicy(agent(), 'web'), /list/);
  assert.throws(() => h.guard.setPolicy(agent(), ['']), /list/);
});
