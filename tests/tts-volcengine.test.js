import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';
import { createTts, DEFAULT_POOL, decideVoice } from '../lib/tts.js';

const key = 'test-secret-not-a-real-key';
const config = () => ({ ttsDoubaoApiKey: key, ttsMode: 'all', ttsVoiceRandom: false });

function python(t, render) {
  const calls = [];
  t.mock.method(childProcess, 'spawn', (cmd, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = t.mock.fn(() => { queueMicrotask(() => child.emit('close', null)); return true; });
    const output = args.find((a) => a.startsWith('--output=')).slice('--output='.length);
    const call = { cmd, args, opts, child, output };
    calls.push(call);
    queueMicrotask(() => render(call));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

function succeed({ child, output }) {
  fs.writeFileSync(output, Buffer.from([1, 2, 3, 4, 5]));
  child.stdout.end(JSON.stringify({ status: 'success', local_path: output }));
  child.emit('close', 0);
}

test('missing API key stays text-only even when legacy local/HTTP settings exist', async (t) => {
  const calls = python(t, () => assert.fail('must not start Python'));
  const tts = createTts({ ttsMode: 'all', ttsUrl: 'https://old.invalid', ttsLocalEngine: true }, null, null,
    { local: { available() { assert.fail('must not inspect local engine'); } } });
  assert.equal(tts.settings().engine, 'none');
  assert.equal(tts.plan(null, { text: '你好' }).reason, 'no-doubao-api-key');
  assert.equal(tts.plan(null, { text: '你好', userText: '发语音' }).send, false);
  assert.equal(await tts.synth('你好'), '');
  assert.match(tts.stats().configurationError, /API Key/);
  assert.match(tts.stats().lastError, /未配置/);
  assert.equal(calls.length, 0);
});

test('official script gets isolated credentials, literal text, selected voice and cached audio', async (t) => {
  const calls = python(t, succeed);
  const cfg = config();
  const tts = createTts(cfg);
  const plan = tts.plan(null, { text: '你好' });
  assert.equal(plan.engine, 'doubao');
  assert.equal(tts.stats().url, 'https://openspeech.bytedance.com/api/v3/tts/unidirectional');
  assert.equal(plan.voice, DEFAULT_POOL[0]);
  const text = '--help; $(touch impossible)' + '中'.repeat(400);
  assert.equal(await tts.synth(text, plan.voice), 'AQIDBAU=');
  assert.equal(await tts.synth(text, plan.voice), 'AQIDBAU=');
  assert.equal(calls.length, 1);
  const call = calls[0];
  assert.equal(call.cmd, 'python3');
  assert.match(call.args[1], /vendor[\\/]doubao-tts[\\/]scripts[\\/]text_to_speech\.py$/);
  assert.equal(call.args.find((a) => a.startsWith('--text=')).slice(7), text.slice(0, 300));
  assert.equal(call.opts.env.MODEL_SPEECH_API_KEY, key);
  assert.equal(call.opts.env.MODEL_SPEECH_API_BASE, 'openspeech.bytedance.com');
  assert.equal(call.opts.env.ARK_SKILL_API_KEY, '');
  assert.equal(call.opts.env.MODEL_SPEECH_TTS_RESOURCE_ID, 'seed-tts-2.0');
  assert.match(call.opts.env.PYTHONPATH, /vendor[\\/]doubao-tts[\\/]python$/);
  assert.equal(call.opts.shell, undefined);
  assert.ok(!call.args.join(' ').includes(key));
  assert.equal(fs.existsSync(path.dirname(call.output)), false);
  cfg.ttsDoubaoResourceId = 'seed-tts-1.0';
  await tts.synth(text, plan.voice);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].opts.env.MODEL_SPEECH_TTS_RESOURCE_ID, 'seed-tts-1.0');
});

test('business failures redact credentials and clean temporary audio', async (t) => {
  const calls = python(t, ({ child }) => {
    child.stdout.end(JSON.stringify({ status: 'error', error: `API error code=45000000: rejected ${key}` }));
    child.emit('close', 1);
  });
  const warnings = [];
  const tts = createTts(config(), { warn: (s) => warnings.push(s) });
  assert.equal(await tts.synth('你好'), '');
  assert.equal(tts.stats().failed, 1);
  assert.equal(tts.stats().degraded, true);
  assert.match(tts.stats().lastError, /45000000/);
  assert.ok(!JSON.stringify([warnings, tts.stats()]).includes(key));
  assert.equal(fs.existsSync(path.dirname(calls[0].output)), false);
});

test('invalid credential/resource header values fail before spawning and never echo credentials', async (t) => {
  const calls = python(t, () => assert.fail('must reject invalid header input locally'));
  for (const bad of [{ ttsDoubaoApiKey: 'secret\ninjected' }, { ttsDoubaoResourceId: 'seed-tts\r\ninjected' }]) {
    const tts = createTts({ ...config(), ...bad });
    assert.equal(await tts.synth('你好'), '');
    assert.match(tts.stats().lastError, /格式无效/);
    assert.ok(!tts.stats().lastError.includes('secret'));
  }
  assert.equal(calls.length, 0);
});

test('only the exact legacy default pool falls back, preserving stored and custom values', () => {
  const cfg = { ...config(), ttsVoicePool: '软萌少女,甜妹,奶音,软糯小助手' };
  const tts = createTts(cfg);
  assert.deepEqual(tts.settings().pool, DEFAULT_POOL);
  assert.equal(tts.settings().voice, DEFAULT_POOL[0]);
  assert.equal(cfg.ttsVoicePool, '软萌少女,甜妹,奶音,软糯小助手');
  cfg.ttsVoicePool = 'custom_speaker,自定义音色';
  assert.deepEqual(tts.settings().pool, ['custom_speaker', '自定义音色']);
  cfg.ttsVoicePool = '软萌少女,甜妹';
  assert.deepEqual(tts.settings().pool, ['软萌少女', '甜妹']);
});

test('missing Python produces a clear failure and no residual directory', async (t) => {
  const calls = python(t, ({ child }) => {
    child.emit('error', Object.assign(new Error('missing'), { code: 'ENOENT' }));
    child.emit('close', -2);
  });
  const tts = createTts(config());
  assert.equal(await tts.synth('你好'), '');
  assert.match(tts.stats().lastError, /未找到 python3/);
  assert.equal(fs.existsSync(path.dirname(calls[0].output)), false);
});

test('total timeout kills only its own synthesis process and clears files', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  t.after(() => t.mock.timers.reset());
  const calls = python(t, () => {});
  const tts = createTts(config());
  const result = tts.synth('你好');
  t.mock.timers.tick(30000);
  assert.equal(await result, '');
  assert.deepEqual(calls[0].child.kill.mock.calls[0].arguments, ['SIGKILL']);
  assert.match(tts.stats().lastError, /超时/);
  assert.equal(fs.existsSync(path.dirname(calls[0].output)), false);
});

test('dispose cancels current synthesis and prevents future launches', async (t) => {
  const calls = python(t, () => {});
  const tts = createTts(config());
  const result = tts.synth('你好');
  tts.dispose();
  assert.equal(await result, '');
  assert.equal(await tts.synth('再见'), '');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].child.kill.mock.callCount(), 1);
  assert.equal(tts.plan(null, { text: '你好' }).reason, 'disposed');
  assert.equal(fs.existsSync(path.dirname(calls[0].output)), false);
});

test('cancellation waits for process close before cleaning late output, including failed kill', async (t) => {
  for (const fail of ['', 'throw', 'false']) {
    const calls = python(t, () => {});
    const tts = createTts(config());
    let settled = false;
    const result = tts.synth('你好').then((audio) => { settled = true; return audio; });
    const call = calls[0];
    t.mock.method(call.child, 'kill', () => { if (fail === 'throw') throw new Error('EPERM'); return fail !== 'false'; });
    tts.dispose();
    await Promise.resolve();
    assert.equal(settled, false);
    assert.equal(fs.existsSync(path.dirname(call.output)), true);
    fs.writeFileSync(call.output, 'late output');
    call.child.emit('close', null);
    assert.equal(await result, '');
    assert.equal(fs.existsSync(path.dirname(call.output)), false);
    if (fail) assert.match(tts.stats().lastError, /终止进程失败/);
  }
});

test('force, keyword, random probability, rule overrides and NapCat record contract remain', async () => {
  const sent = [];
  const tts = createTts({ ...config(), ttsMode: 'off', ttsKeywords: '你好' }, null, {
    sendGroup: async (...args) => sent.push(['group', ...args]),
    sendPrivate: async (...args) => sent.push(['private', ...args]),
  });
  assert.equal(tts.plan(null, { text: '你好' }).send, false);
  assert.equal(tts.plan(null, { text: '你好', userText: '发语音' }).force, true);
  assert.equal(tts.plan({ ttsMode: 'keyword' }, { text: '你好' }).send, true);
  assert.equal(tts.plan({ ttsMode: 'all' }, { text: '你好' }).send, true);
  assert.equal(decideVoice({ mode: 'random', probability: 0 }, { text: '你好', rng: () => 0 }).send, false);
  assert.equal(decideVoice({ mode: 'random', probability: 100 }, { text: '你好', rng: () => 0.99 }).send, true);
  await tts.send({ type: 'group', id: 123 }, 'AQI=', DEFAULT_POOL[0]);
  await tts.send({ type: 'private', id: 456 }, 'AQI=', DEFAULT_POOL[0]);
  assert.deepEqual(sent, [
    ['group', 123, [{ type: 'record', data: { file: 'base64://AQI=' } }]],
    ['private', 456, [{ type: 'record', data: { file: 'base64://AQI=' } }]],
  ]);
});
