import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { installLoader, prepareNapcat, prepareQQ, processIdentity, identityMatches, relocateXvfb, stopOwned } from '../lib/linux-runtime.js';

test('QQ loader preserves the original entry and is idempotent', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-qq-'));
  try {
    const app = path.join(root, 'resources', 'app');
    fs.mkdirSync(app, { recursive: true });
    const qq = path.join(root, 'qq');
    fs.writeFileSync(qq, 'fixture', { mode: 0o755 });
    const original = JSON.stringify({ main: './application.asar/app_launcher/index.js', version: 'fixture' });
    fs.writeFileSync(path.join(app, 'package.json'), original);
    assert.equal(await prepareQQ(root, '', qq), qq);
    installLoader(qq);
    installLoader(qq);
    assert.equal(fs.readFileSync(path.join(app, 'package.dsh-original.json'), 'utf8'), original);
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).main, './loadDshNapcat.cjs');
    assert.match(fs.readFileSync(path.join(app, 'loadDshNapcat.cjs'), 'utf8'), /DSH_NAPCAT_MAIN/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('QQ loader refuses to overwrite an existing unrecognised backup', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-conflict-'));
  try {
    const app = path.join(root, 'resources', 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'package.json'), '{"main":"original"}');
    fs.writeFileSync(path.join(app, 'package.dsh-original.json'), 'keep');
    assert.throws(() => installLoader(path.join(root, 'qq')), /冲突/);
    assert.equal(fs.readFileSync(path.join(app, 'package.dsh-original.json'), 'utf8'), 'keep');
    assert.equal(JSON.parse(fs.readFileSync(path.join(app, 'package.json'))).main, 'original');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('incorrect downloads are rejected and temporary files are removed', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-missing-'));
  t.mock.method(globalThis, 'fetch', async () => new Response('bad archive'));
  try {
    await assert.rejects(prepareQQ(root, ''), /SHA-256/);
    await assert.rejects(prepareNapcat(root), /SHA-256/);
    assert.deepEqual(fs.readdirSync(path.join(root, 'runtime')), []);
  }
  finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('Xvfb compiler path is relocated only when the expected binary string is unique', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'napcat-xvfb-'));
  try {
    const file = path.join(root, 'Xvfb');
    const marker = Buffer.from('/usr/bin\0');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('prefix'), marker, Buffer.from('suffix')]));
    relocateXvfb(file);
    assert.equal(fs.readFileSync(file).includes(marker), false);
    assert.throws(() => relocateXvfb(file), /不符合预期/);
    fs.writeFileSync(file, Buffer.concat([marker, marker]));
    assert.throws(() => relocateXvfb(file), /不符合预期/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('only the matching owned Linux process group is signalled', { skip: process.platform !== 'linux' }, async () => {
  const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
  try {
    const identity = processIdentity(child.pid);
    assert.ok(identityMatches(identity));
    assert.equal(stopOwned({ ...identity, start: '0' }), false);
    assert.ok(identityMatches(identity));
    const exited = new Promise((resolve) => child.once('exit', resolve));
    assert.equal(stopOwned(identity), true);
    await exited;
    assert.equal(identityMatches(identity), false);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
});
