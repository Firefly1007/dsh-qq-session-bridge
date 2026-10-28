import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureQQPermission } from '../lib/qq-permissions.js';

test('new QQ sessions select auto without changing the global default', () => {
  let current = 'danger-full-access';
  const session = {};
  const presets = { defaultPreset: 'danger-full-access', current: actual => { assert.equal(actual, session); return current; },
    set(actual, value) { assert.equal(actual, session); current = value; } };
  assert.equal(ensureQQPermission({ permissionPresets: presets }, { session }, { newSession: true }), 'auto');
  assert.equal(presets.defaultPreset, 'danger-full-access');
});

test('preserves allowed choices, restores auto for other modes and fails closed', () => {
  let current = 'danger-full-access';
  let writes = 0;
  const presets = { current: () => current, set(_session, value) { writes++; current = value; } };
  const ctx = { permissionPresets: presets };
  const agent = { session: {} };
  assert.equal(ensureQQPermission(ctx, agent), 'danger-full-access');
  assert.equal(writes, 0);
  current = 'workspace-write';
  assert.equal(ensureQQPermission(ctx, agent), 'auto');
  assert.equal(writes, 1);
  presets.set = () => {};
  current = 'custom';
  assert.throws(() => ensureQQPermission(ctx, agent), /无法确认/);
  assert.throws(() => ensureQQPermission({}, agent), /不可用/);
});
