import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQQSettings } from '../lib/qq-settings.js';

test('new settings persist independently and generate a private OneBot token', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-settings-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const old = path.join(root, 'napcat-bot');
  fs.mkdirSync(old);
  fs.writeFileSync(path.join(old, 'config.json'), JSON.stringify({ ttsDoubaoApiKey: 'old-secret' }));
  const directory = path.join(root, 'qq-native');
  const first = createQQSettings({ directory });
  assert.equal(first.config.ttsDoubaoApiKey, '');
  assert.match(first.config.napcatToken, /^[0-9a-f]{64}$/);
  first.update({ superUsers: '1, 2', modelProvider: 'provider', modelId: 'model', asrDoubaoApiKey: 'new-secret' });
  const second = createQQSettings({ directory });
  assert.equal(second.config.napcatToken, first.config.napcatToken);
  assert.equal(second.config.asrDoubaoApiKey, 'new-secret');
  const token = second.config.napcatToken;
  second.update({ napcatToken: '' });
  assert.match(second.config.napcatToken, /^[0-9a-f]{64}$/);
  assert.notEqual(second.config.napcatToken, token);
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(directory, 'settings.json')).mode & 0o077, 0);
});

test('invalid updates cannot mutate or overwrite valid settings', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settings = createQQSettings({ directory });
  const original = fs.readFileSync(path.join(directory, 'settings.json'), 'utf8');
  for (const input of [{ superUsers: '1,invalid' }, { modelProvider: 'provider' }, { receiveMode: 'bad' },
    { napcatHttpUrl: 'http://user:pass@example.test' }, { webuiPort: 0 }, { unknown: true }]) {
    assert.throws(() => settings.update(input));
    assert.equal(fs.readFileSync(path.join(directory, 'settings.json'), 'utf8'), original);
  }
  assert.equal(settings.config.superUsers, '');
});
