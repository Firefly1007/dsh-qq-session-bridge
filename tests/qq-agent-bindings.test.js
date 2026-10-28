import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQQAgentBindings } from '../lib/qq-agent-bindings.js';
import { createQQRootGuard } from '../lib/qq-root-guard.js';
import { createQQFileSnapshotStore } from '../lib/qq-file-tool.js';

const temporaryRoots = [];
after(() => { for (const root of temporaryRoots) fs.rmSync(root, { recursive: true, force: true }); });

function listeners() {
  const events = new Map();
  return {
    on(name, callback) {
      if (!events.has(name)) events.set(name, new Set());
      events.get(name).add(callback);
      return () => events.get(name)?.delete(callback);
    },
    emit(name, ...args) { for (const callback of [...(events.get(name) || [])]) callback(...args); },
  };
}

function fixture() {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-bindings-'));
  temporaryRoots.push(temporary);
  const workspace = path.join(temporary, 'workspace');
  fs.mkdirSync(workspace);
  const snapshotStore = createQQFileSnapshotStore({ directory: path.join(temporary, 'snapshots') });
  const hostEvents = listeners();
  const live = new Map();
  const bindings = new Map();
  const archived = new Set();
  const services = new Map();
  const guards = [];
  const sends = [];
  const delegations = [];
  const syntheses = [];
  const config = { superUsers: '1', ttsDoubaoApiKey: 'isolated-test-key', ttsVoice: 'voice-1' };
  const permission = new WeakMap();
  let message = 0;
  const ctx = {
    ...hostEvents,
    attachments: { async *readFileStream() {} },
    tools: { schemas: () => [], guard(callback) { guards.push(callback); return () => {}; } },
    get(name) { return services.get(name) || ctx[name]; },
    provide(name, value) { services.set(name, value); return () => { if (services.get(name) === value) services.delete(name); }; },
    agents: { get: id => live.get(id), list: () => [...live.values()] },
    agentPresets: { defaultId: 'standard', composedPreset: scope => scope.preset },
    permissionPresets: { current: session => permission.get(session) || 'danger-full-access',
      set(session, value) { permission.set(session, value); } },
    subagents: {
      resolveMaxDepth: () => 3,
      async startActivation(request) { delegations.push(request); return { childId: 'standard-child' }; },
    },
    sessionController: {
      async prompt(request) {
        const agent = live.get(request.sessionId);
        const input = { id: `message-${++message}`, role: 'user', source: { kind: 'user', rpcId: request.requestId }, content: request.content };
        agent.events.emit('agent/inbox/inserted', { agent, message: input });
        if (agent.status === 'running') agent.events.emit('session/event', agent.session, { type: 'turn/end', data: { turn: message - 1 } });
        agent.status = 'running';
        agent.events.emit('session/event', agent.session, { type: 'turn/start', data: { turn: message } });
        agent.events.emit('agent/inbox/claimed', { agent, message: input, turn: message });
        agent.events.emit('session/event', agent.session, { type: 'step/start', data: { turn: message, step: 1 } });
        agent.events.emit('session/event', agent.session, { type: 'user/message', data: input });
        return { accepted: true };
      },
    },
  };
  const rootGuard = createQQRootGuard(ctx);
  const nap = { async sendAction(...args) { sends.push(args); return { status: 'sent', messageId: sends.length }; } };
  const options = {
    ctx, rootGuard, nap, snapshotStore, getConfig: () => config,
    lookupBySessionId: id => archived.has(id) ? null : bindings.get(id) || null,
    async synthesize(...args) { syntheses.push(args); return 'base64-audio'; },
  };
  function agent(id = 'qq-session-1', overrides = {}) {
    const events = listeners();
    const tools = new Map();
    const localGuards = [];
    const effects = [];
    const scope = {
      preset: 'bot', ...events,
      effect(create) { const dispose = create(); effects.push(dispose); return dispose; },
      tools: {
        restrict() {},
        guard(callback) { localGuards.push(callback); return () => { const i = localGuards.indexOf(callback); if (i >= 0) localGuards.splice(i, 1); }; },
        register(tool) {
          if (tools.has(tool.name)) throw new Error('duplicate tool');
          tools.set(tool.name, tool);
          return () => tools.delete(tool.name);
        },
      },
    };
    const subject = { id, ctx: scope, events, tools, guards: localGuards, status: 'idle',
      session: { header: { id, cwd: workspace }, snapshotEvents: () => [] }, ...overrides };
    subject.closeScope = () => { for (const dispose of [...effects].reverse()) dispose(); };
    return subject;
  }
  const binding = (subject, key = 'private:2') => ({ key, sessionId: subject.id, workspaceId: 'workspace-1', workspacePath: subject.session.header.cwd });
  const publish = subject => { live.set(subject.id, subject); hostEvents.emit('agent/created', { agent: subject }); };
  const execute = async (subject, name, args = {}, signal = new AbortController().signal) => {
    const execution = { agent: subject, name, arguments: args, signal };
    for (const guard of [...guards, ...subject.guards]) {
      const denied = guard(execution);
      if (denied) return { denied };
    }
    const tool = subject.tools.get(name);
    return tool ? tool.execute(args, execution) : { denied: 'unknown tool' };
  };
  const input = (coordinator, subject, senderId = '1') => coordinator.getPromptBridge(subject).prompt({
    senderId, mode: 'queue', content: [{ type: 'text', text: 'trusted QQ' }],
  });
  return { ctx, rootGuard, options, live, bindings, archived, config, sends, delegations, syntheses, services, agent, binding, publish, execute, input, nap, workspace, permission };
}

test('prepublication setup keeps new roots blocked until an exact committed bot binding activates', async () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  const commit = coordinator.setupAgent(agent.ctx, agent, { key: 'private:2' });
  commit.commit();
  assert.equal(h.permission.get(agent.session), 'auto');
  assert.ok(agent.tools.has('qq_send_text'));
  assert.equal(agent.tools.has('qq_send_file'), true);
  assert.ok((await h.execute(agent, 'qq_send_file', { path: 'sample.txt' })).denied);
  h.publish(agent);
  assert.equal(coordinator.getPromptBridge(agent), null);
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'before activation' })).denied);
  const binding = h.binding(agent);
  h.bindings.set(agent.id, binding);
  assert.equal(coordinator.activate(agent, { ...binding, workspacePath: '/other' }), false);
  assert.equal(coordinator.activate(agent, binding), true);
  h.permission.set(agent.session, 'workspace-write');
  assert.equal((await h.input(coordinator, agent)).status, 'accepted');
  assert.equal(h.permission.get(agent.session), 'auto');
  assert.equal((await h.execute(agent, 'qq_send_text', { text: 'ready' })).status, 'sent');
  assert.equal(h.sends.length, 1);
  h.permission.set(agent.session, 'workspace-write');
  h.ctx.permissionPresets.set = () => { throw new Error('auto unavailable'); };
  assert.equal((await h.input(coordinator, agent)).code, 'QQ_PERMISSION_UNAVAILABLE');
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'no longer active' })).denied);
  coordinator.dispose();
});

test('failed permission initialization cannot activate a partially prepared Agent', async () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  const commit = coordinator.setupAgent(agent.ctx, agent, { key: 'private:2' });
  const binding = h.binding(agent);
  h.bindings.set(agent.id, binding);
  h.live.set(agent.id, agent);
  assert.equal(coordinator.activate(agent, binding), false);
  h.ctx.permissionPresets.set = () => { throw new Error('auto unavailable'); };
  assert.throws(() => commit.commit(), /auto unavailable/);
  assert.equal(coordinator.activate(agent, binding), false);
  assert.equal(coordinator.getPromptBridge(agent), null);
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'no' })).denied);
  coordinator.dispose();
});

test('a trusted unsent QQ turn schedules only one reminder with send but no delegation authority', async () => {
  const h = fixture();
  const requests = [];
  const prompt = h.ctx.sessionController.prompt;
  h.ctx.sessionController.prompt = async (...args) => { requests.push(args[0]); return prompt(...args); };
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  coordinator.setupAgent(agent.ctx, agent, { key: 'private:2' }).commit();
  h.publish(agent);
  const binding = h.binding(agent); h.bindings.set(agent.id, binding);
  assert.equal(coordinator.activate(agent, binding), true);
  assert.equal((await h.input(coordinator, agent)).status, 'accepted');
  agent.events.emit('session/event', agent.session, { type: 'step/end', data: { turn: 1, step: 1 } });
  agent.events.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  assert.match(requests[1].content[0].text, /没有成功向 QQ 发送/);
  assert.equal((await h.execute(agent, 'qq_send_text', { text: 'reply' })).status, 'sent');
  assert.ok((await h.execute(agent, 'qq_delegate', { prompt: 'work', description: 'task' })).denied);
  agent.events.emit('session/event', agent.session, { type: 'step/end', data: { turn: 2, step: 1 } });
  agent.events.emit('session/event', agent.session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.length, 2);
  coordinator.dispose();
});

test('reenabling binds an existing Agent without retaining the disposed scope guards', async () => {
  const h = fixture();
  const first = createQQAgentBindings(h.options);
  const agent = h.agent();
  first.setupAgent(agent.ctx, agent, { key: 'private:2' }).commit();
  h.publish(agent);
  const binding = h.binding(agent); h.bindings.set(agent.id, binding);
  assert.equal(first.activate(agent, binding), true);
  assert.equal((await h.input(first, agent)).status, 'accepted');
  assert.equal((await h.execute(agent, 'qq_send_text', { text: 'first' })).status, 'sent');
  first.dispose();
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'disabled' })).denied);
  const second = createQQAgentBindings(h.options);
  assert.ok(second.getPromptBridge(agent));
  assert.equal((await h.input(second, agent)).status, 'accepted');
  assert.equal((await h.execute(agent, 'qq_send_text', { text: 'second' })).status, 'sent');
  second.dispose();
});

test('file sending is bound to the QQ root and an authorized input', { skip: process.platform !== 'linux' }, async () => {
  const h = fixture();
  fs.writeFileSync(path.join(h.workspace, 'sample.txt'), 'sample');
  h.nap.sendAction = async (...args) => { h.sends.push(args); return { status: 'sent', fileId: null }; };
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  coordinator.setupAgent(agent.ctx, agent, { key: 'private:2' }).commit();
  h.publish(agent);
  const binding = h.binding(agent);
  h.bindings.set(agent.id, binding);
  assert.equal(coordinator.activate(agent, binding), true);
  assert.ok((await h.execute(agent, 'qq_send_file', { path: 'sample.txt' })).denied);
  await h.input(coordinator, agent, '2');
  assert.equal((await h.execute(agent, 'qq_send_file', { path: 'sample.txt' })).status, 'sent');
  assert.equal(h.sends[0][0], 'upload_private_file');
  assert.equal(h.sends[0][1].user_id, '2');
  const foreign = await agent.tools.get('qq_send_file').execute({ path: 'sample.txt' }, { agent: {} });
  assert.equal(foreign.code, 'WRONG_AGENT');
  coordinator.dispose();
});

test('created and startup scans initialize only known committed bot roots', async () => {
  const h = fixture();
  const startup = h.agent('qq-session-startup');
  const unknown = h.agent('qq-session-unknown');
  const wrong = h.agent('qq-session-wrong');
  wrong.ctx.preset = 'standard';
  for (const subject of [startup, unknown, wrong]) h.live.set(subject.id, subject);
  h.bindings.set(startup.id, h.binding(startup));
  h.bindings.set(wrong.id, h.binding(wrong));
  const coordinator = createQQAgentBindings(h.options);
  assert.ok(coordinator.getPromptBridge(startup));
  assert.equal(coordinator.getPromptBridge(unknown), null);
  assert.equal(coordinator.getPromptBridge(wrong), null);
  const restored = h.agent('qq-session-restored');
  h.bindings.set(restored.id, h.binding(restored));
  h.publish(restored);
  assert.ok(coordinator.getPromptBridge(restored));
  assert.ok((await h.execute(restored, 'qq_send_text', { text: 'web page' })).denied);
  assert.equal(h.sends.length, 0);
  coordinator.dispose();
});

test('prepublication restrictions name only currently registered global tools', () => {
  const h = fixture();
  h.ctx.tools.schemas = () => [{ name: 'web_search' }, { name: 'exec' }];
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  let restricted;
  agent.ctx.tools.restrict = filter => {
    restricted = filter.allow;
    assert.deepEqual(filter.allow, ['web_search']);
  };
  coordinator.setupAgent(agent.ctx, agent, { key: 'private:2' }).commit();
  assert.deepEqual(restricted, ['web_search']);
  coordinator.dispose();
});

test('QQ superuser delegation and dynamic administrator changes use the current default child preset', async () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  h.bindings.set(agent.id, h.binding(agent));
  h.publish(agent);
  await h.input(coordinator, agent, '1');
  assert.equal((await h.execute(agent, 'qq_delegate', { prompt: 'work', description: 'task' })).kind, 'activation');
  assert.equal(h.delegations[0].request.agentPreset, 'standard');
  h.config.superUsers = '';
  assert.ok((await h.execute(agent, 'qq_delegate', { prompt: 'work', description: 'task' })).denied);
  assert.equal((await h.execute(agent, 'qq_send_text', { text: 'still talking' })).status, 'sent');
  h.config.superUsers = '2';
  h.ctx.agentPresets.defaultId = 'bot';
  await h.input(coordinator, agent, '2');
  assert.equal((await h.execute(agent, 'qq_delegate', { prompt: 'new task', description: 'task' })).kind, 'activation');
  assert.equal(h.delegations[1].request.agentPreset, 'standard');
  assert.equal(h.delegations.length, 2);
  coordinator.dispose();
});

test('voice reads current configuration without locking the existing Agent', async () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  h.bindings.set(agent.id, h.binding(agent));
  h.publish(agent);
  await h.input(coordinator, agent);
  await h.execute(agent, 'qq_send_voice', { text: 'first' });
  h.config.ttsVoice = 'voice-2';
  h.config.ttsDoubaoApiKey = 'new-isolated-key';
  await h.execute(agent, 'qq_send_voice', { text: 'second' });
  assert.deepEqual(h.syntheses.map(args => args[2]), ['voice-1', 'voice-2']);
  assert.equal(h.syntheses[1][0].ttsDoubaoApiKey, 'new-isolated-key');
  coordinator.dispose();
});

test('archive, binding changes and preset changes revoke current tools and cached prompt handles', async () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  const binding = h.binding(agent);
  h.bindings.set(agent.id, binding);
  h.publish(agent);
  const cached = coordinator.getPromptBridge(agent);
  await h.input(coordinator, agent);
  h.archived.add(agent.id);
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'archived' })).denied);
  assert.equal((await cached.prompt({ senderId: '1', mode: 'queue', content: [{ type: 'text', text: 'late' }] })).status, 'failed');
  h.archived.delete(agent.id);
  assert.equal(coordinator.activate(agent, binding), true);
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'old turn' })).denied);
  await h.input(coordinator, agent);
  assert.equal((await h.execute(agent, 'qq_send_text', { text: 'new turn' })).status, 'sent');
  agent.ctx.preset = 'standard';
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'wrong preset' })).denied);
  assert.equal(coordinator.getPromptBridge(agent), null);
  assert.equal(h.sends.length, 1);
  coordinator.dispose();
});

test('a replacement instance cannot reuse old authorization and delayed old disposal cannot revoke the new one', async () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const first = h.agent();
  h.bindings.set(first.id, h.binding(first));
  h.publish(first);
  await h.input(coordinator, first);
  const restored = h.agent(first.id);
  h.publish(restored);
  assert.equal(coordinator.getPromptBridge(first), null);
  assert.ok((await h.execute(restored, 'qq_send_text', { text: 'old authority' })).denied);
  await h.input(coordinator, restored);
  h.ctx.emit('agent/disposed', { agent: first });
  assert.equal((await h.execute(restored, 'qq_send_text', { text: 'new authority' })).status, 'sent');
  coordinator.dispose();
});

test('setup failure cannot activate a partially registered scope', () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  const register = agent.ctx.tools.register;
  agent.ctx.tools.register = definition => {
    if (definition.name === 'qq_send_voice') throw new Error('registration failed');
    return register(definition);
  };
  assert.throws(() => coordinator.setupAgent(agent.ctx, agent, { key: 'private:2' }), /registration failed/);
  assert.equal(agent.tools.size, 0);
  h.bindings.set(agent.id, h.binding(agent));
  h.publish(agent);
  assert.equal(coordinator.getPromptBridge(agent), null);
  assert.equal(coordinator.activate(agent, h.binding(agent)), false);
  coordinator.dispose();
});

test('disabling stops pending queue work, revokes policies and prevents cached prompt reuse', async () => {
  const h = fixture();
  const coordinator = createQQAgentBindings(h.options);
  const agent = h.agent();
  h.bindings.set(agent.id, h.binding(agent));
  h.publish(agent);
  await h.input(coordinator, agent);
  const cached = coordinator.getPromptBridge(agent);
  const first = Promise.withResolvers();
  const started = Promise.withResolvers();
  h.nap.sendAction = async (...args) => { h.sends.push(args); started.resolve(); return first.promise; };
  const one = h.execute(agent, 'qq_send_text', { text: 'one' });
  const two = h.execute(agent, 'qq_send_text', { text: 'two' });
  await started.promise;
  coordinator.dispose();
  first.resolve({ status: 'unknown', code: 'SEND_CANCELLED' });
  assert.equal((await one).status, 'unknown');
  assert.equal((await two).status, 'failed');
  assert.equal(h.sends.length, 1);
  assert.equal(h.services.has('qqBotBridge'), false);
  assert.equal((await cached.prompt({ senderId: '1', mode: 'queue', content: [{ type: 'text', text: 'late' }] })).status, 'failed');
  assert.ok((await h.execute(agent, 'qq_send_text', { text: 'after stop' })).denied);
});
