import test from 'node:test';
import assert from 'node:assert/strict';
import { createQQSendQueue, registerQQTextTool } from '../lib/qq-text-tool.js';
import { QQ_VOICE_TOOL, registerQQVoiceTool } from '../lib/qq-voice-tool.js';

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const tools = new Map();
  let permit = Object.freeze({});
  const agent = { id: 'qq-main', ctx: { tools: {
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
  } } };
  const authorization = {
    captureSendPermit: () => permit,
    canSend: value => !!permit && value === permit,
  };
  const config = { ttsDoubaoApiKey: 'test-only-unused-key', ttsVoice: 'fixed_authorized_speaker',
    ttsDoubaoResourceId: 'seed-tts-2.0', ...options.config };
  const channel = options.channel || { type: 'private', id: '123' };
  const sends = [];
  const syntheses = [];
  const nap = { async sendAction(...args) {
    sends.push(args);
    return options.send ? options.send(...args) : { status: 'sent', messageId: sends.length };
  } };
  const synthesize = async (...args) => {
    syntheses.push(args);
    return options.synthesize ? options.synthesize(...args) : 'YXVkaW8=';
  };
  const sendQueue = createQQSendQueue({ agent, authorization });
  const dispose = registerQQVoiceTool({ agent, sendQueue, nap, channel, config, synthesize });
  const tool = tools.get(QQ_VOICE_TOOL);
  const execute = (args = { text: 'hello' }, values = {}) => tool.execute(args, {
    agent, signal: new AbortController().signal, ...values,
  });
  return { agent, config, channel, nap, sendQueue, sends, syntheses, tool, dispose, execute, tools,
    end() { permit = null; }, next() { permit = Object.freeze({}); },
    registerText() { registerQQTextTool({ agent, sendQueue, nap, channel }); return tools.get('qq_send_text'); },
  };
}

test('voice uses only fixed target and configured speaker, preserves full text, and sends no extra text on success', async () => {
  const h = fixture({ config: { ttsVoiceRandom: true, ttsVoicePool: 'ignored', ttsMaxChars: 1 } });
  h.channel.id = '999';
  const text = ' --help [CQ:at,qq=999] ' + '长'.repeat(1000);
  const output = await h.execute({ text });
  assert.equal(h.tool.name, QQ_VOICE_TOOL);
  assert.equal(h.tool.parameters.properties.text.maxLength, undefined);
  assert.equal(output.status, 'sent');
  assert.equal(output.messageId, 1);
  assert.equal(h.syntheses.length, 1);
  assert.equal(h.syntheses[0][1], text);
  assert.equal(h.syntheses[0][2], 'fixed_authorized_speaker');
  assert.deepEqual(h.syntheses[0][0], { ttsDoubaoApiKey: 'test-only-unused-key', ttsDoubaoResourceId: 'seed-tts-2.0' });
  assert.equal(h.sends.length, 1);
  assert.deepEqual(h.sends[0].slice(0, 2), ['send_private_msg', {
    user_id: '123', message: [{ type: 'record', data: { file: 'base64://YXVkaW8=' } }],
  }]);
  assert.match(h.tool.output.render({}, output)[0].text, /"status":"sent"/);
  const group = fixture({ channel: { type: 'group', id: '456' } });
  await group.execute();
  assert.equal(group.sends[0][0], 'send_group_msg');
  assert.equal(group.sends[0][1].group_id, '456');
});

test('voice refuses invalid text, model-selected speaker or destination, and foreign Agents before synthesis', async () => {
  const h = fixture();
  for (const args of [null, [], {}, { text: '' }, { text: ' \n' }, { text: 12 },
    { text: 'x', voice: 'other' }, { text: 'x', target: 'other' }, { text: 'x', group_id: '999' }]) {
    assert.equal((await h.execute(args)).status, 'failed');
  }
  assert.equal((await h.execute({ text: 'hello' }, { agent: { id: h.agent.id } })).code, 'WRONG_AGENT');
  assert.equal(h.syntheses.length, 0);
  assert.equal(h.sends.length, 0);
});

test('missing key or fixed speaker attempts literal text but exposes only voice failure', async () => {
  for (const config of [{ ttsDoubaoApiKey: '' }, { ttsVoice: ' ' }]) {
    const h = fixture({ config });
    const output = await h.execute({ text: ' [CQ:at,qq=999] text ' });
    assert.equal(output.status, 'failed');
    assert.equal(output.code, 'VOICE_NOT_CONFIGURED');
    assert.equal(h.syntheses.length, 0);
    assert.equal(h.sends.length, 1);
    assert.deepEqual(h.sends[0][1], { user_id: '123', message: [{ type: 'text', data: { text: ' [CQ:at,qq=999] text ' } }] });
    assert.deepEqual(Object.keys(output).sort(), ['code', 'message', 'status']);
    assert.equal(output.fallback, undefined);
    assert.doesNotMatch(h.tool.output.render({}, output)[0].text, /补发|降级|"sent"/);
  }
});

test('official overlength errors refuse text without guessing a character cap or sending a fallback', async () => {
  for (const error of [Object.assign(new Error('too long'), { code: 40402003 }),
    Object.assign(new Error('too long'), { code: '40402003' }),
    new Error('豆包语音合成失败：API error code=40402003: text too long')]) {
    const h = fixture({ synthesize: async () => { throw error; } });
    const text = '长'.repeat(1500);
    const output = await h.execute({ text });
    assert.equal(output.status, 'failed');
    assert.equal(output.code, 'VOICE_TEXT_TOO_LONG');
    assert.equal(h.syntheses[0][1], text);
    assert.equal(h.sends.length, 0);
  }
});

test('synthesis errors and empty audio try text once without leaking provider errors or fallback status', async () => {
  for (const synthesize of [async () => { throw new Error('provider failure with test-only-unused-key'); }, async () => '']) {
    const h = fixture({ synthesize });
    const output = await h.execute();
    assert.equal(output.status, 'failed');
    assert.equal(output.code, 'VOICE_SYNTHESIS_FAILED');
    assert.equal(output.messageId, undefined);
    assert.equal(output.fallback, undefined);
    assert.doesNotMatch(JSON.stringify(output), /test-only-unused-key|"sent"/);
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0][1].message[0].type, 'text');
  }
});

test('explicit voice-send failure attempts text once while retaining a voice-only failed tool result', async () => {
  const h = fixture({ send: async (_action, params) => params.message[0].type === 'record'
    ? { status: 'failed', code: 'ONEBOT_REJECTED' } : { status: 'sent', messageId: 42 } });
  const output = await h.execute();
  assert.equal(output.status, 'failed');
  assert.equal(output.code, 'VOICE_SEND_FAILED');
  assert.deepEqual(h.sends.map(call => call[1].message[0].type), ['record', 'text']);
  assert.equal(output.messageId, undefined);
  assert.equal(output.fallback, undefined);
  assert.doesNotMatch(JSON.stringify(output), /42|补发|降级|"sent"/);
});

test('unknown or thrown voice-send results never fall back or retry', async () => {
  for (const response of [{ status: 'unknown', code: 'SEND_TIMEOUT' }, undefined, new Error('acknowledgement lost')]) {
    const h = fixture({ send: async () => { if (response instanceof Error) throw response; return response; } });
    const output = await h.execute();
    assert.equal(output.status, 'unknown');
    assert.equal(output.code, 'VOICE_SEND_UNKNOWN');
    assert.match(output.message, /可能已送达/);
    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[0][1].message[0].type, 'record');
  }
});

test('failed or unknown text fallback never becomes a successful voice result and is not repeated', async () => {
  for (const fallback of [{ status: 'failed' }, { status: 'unknown' }, new Error('text transport failed')]) {
    const h = fixture({ synthesize: async () => { throw new Error('synthesis failed'); },
      send: async () => { if (fallback instanceof Error) throw fallback; return fallback; } });
    const output = await h.execute();
    assert.equal(output.status, 'failed');
    assert.equal(output.code, 'VOICE_SYNTHESIS_FAILED');
    assert.equal(h.sends.length, 1);
    assert.deepEqual(Object.keys(output).sort(), ['code', 'message', 'status']);
  }
});

test('revoked authorization before queue execution does not synthesize or send', async () => {
  const h = fixture();
  h.end();
  assert.equal((await h.execute()).code, 'NOT_AUTHORIZED');
  assert.equal(h.syntheses.length, 0);
  assert.equal(h.sends.length, 0);
});

test('step changes, cancellation, queue stop, and disposal during synthesis prevent both voice and fallback dispatch', async () => {
  for (const change of ['step', 'end', 'cancel', 'stop', 'dispose']) {
    const release = Promise.withResolvers();
    const h = fixture({ synthesize: async () => release.promise });
    const controller = new AbortController();
    const pending = h.execute({ text: 'test' }, { signal: controller.signal });
    await tick();
    assert.equal(h.syntheses.length, 1);
    if (change === 'step') h.next();
    if (change === 'end') h.end();
    if (change === 'cancel') controller.abort();
    if (change === 'stop') h.sendQueue.stop();
    if (change === 'dispose') h.dispose();
    release.resolve('YXVkaW8=');
    assert.equal((await pending).status, 'failed');
    assert.equal(h.sends.length, 0);
    if (['cancel', 'dispose'].includes(change)) assert.equal(h.syntheses[0][3].aborted, true);
  }
});

test('queued voice calls retain their original step and cannot synthesize in a later step', async () => {
  const release = Promise.withResolvers();
  const h = fixture({ synthesize: async () => release.promise });
  const first = h.execute({ text: 'first' });
  const second = h.execute({ text: 'second' });
  await tick();
  h.next();
  release.resolve('YXVkaW8=');
  assert.equal((await first).status, 'failed');
  assert.equal((await second).code, 'NOT_AUTHORIZED');
  assert.equal(h.syntheses.length, 1);
  assert.equal(h.sends.length, 0);
});

test('text and voice share one call-order queue including asynchronous preparation', { timeout: 1000 }, async () => {
  const textReply = Promise.withResolvers();
  const speech = Promise.withResolvers();
  const order = [];
  const h = fixture({ synthesize: async () => { order.push('synthesis'); return speech.promise; },
    send: async (_action, params) => {
      const part = params.message[0];
      order.push(part.type === 'text' ? part.data.text : 'voice');
      return part.type === 'text' && part.data.text === 'first' ? textReply.promise : { status: 'sent', messageId: 8 };
    } });
  const textTool = h.registerText();
  const execution = { agent: h.agent, signal: new AbortController().signal };
  const first = textTool.execute({ text: 'first' }, execution);
  const voice = h.execute({ text: 'voice text' });
  const last = textTool.execute({ text: 'last' }, execution);
  await tick();
  assert.deepEqual(order, ['first']);
  textReply.resolve({ status: 'sent', messageId: 1 });
  await tick();
  assert.deepEqual(order, ['first', 'synthesis']);
  speech.resolve('YXVkaW8=');
  await Promise.all([first, voice, last]);
  assert.deepEqual(order, ['first', 'synthesis', 'voice', 'last']);
});

test('fallback text remains within the voice queue entry before later text calls', { timeout: 1000 }, async () => {
  const h = fixture({ synthesize: async () => { throw new Error('synthesis failed'); } });
  const textTool = h.registerText();
  const voice = h.execute({ text: 'fallback text' });
  const later = textTool.execute({ text: 'later text' }, { agent: h.agent, signal: new AbortController().signal });
  assert.equal((await voice).status, 'failed');
  assert.equal((await later).status, 'sent');
  assert.deepEqual(h.sends.map(call => call[1].message[0].data.text), ['fallback text', 'later text']);
});

test('cancellation after voice dispatch preserves unknown delivery without text fallback', async () => {
  const reply = Promise.withResolvers();
  const h = fixture({ send: async () => reply.promise });
  const controller = new AbortController();
  const pending = h.execute({ text: 'once' }, { signal: controller.signal });
  await tick();
  assert.equal(h.sends.length, 1);
  controller.abort();
  reply.resolve({ status: 'unknown', code: 'SEND_CANCELLED' });
  assert.equal((await pending).status, 'unknown');
  assert.equal(h.sends.length, 1);
});

test('disposal cancels an in-progress fallback but its result remains a voice failure', async () => {
  const reply = Promise.withResolvers();
  const h = fixture({ config: { ttsDoubaoApiKey: '' }, send: async () => reply.promise });
  const pending = h.execute();
  await tick();
  assert.equal(h.sends.length, 1);
  h.dispose();
  assert.equal(h.sends[0][2].signal.aborted, true);
  reply.resolve({ status: 'unknown' });
  assert.equal((await pending).code, 'VOICE_NOT_CONFIGURED');
  assert.equal(h.tools.has(QQ_VOICE_TOOL), false);
});

test('invalid fixed channels and dependencies fail before tool registration', () => {
  assert.throws(() => fixture({ channel: { type: 'group', id: 'bad' } }), /fixed QQ channel/);
  assert.throws(() => registerQQVoiceTool({ agent: {}, sendQueue: {}, nap: {} }), /dependencies/);
});
