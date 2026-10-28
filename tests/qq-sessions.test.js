import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createQQSessionMap } from '../lib/qq-sessions.js';

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'qq-session-map-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'bindings.json');
  const sessions = new Map();
  const persisted = new Map();
  const workspaces = new Map();
  const calls = { create: 0, resolve: 0, attach: 0, resolvePreset: [], mountPreset: [], setup: [], globalSave: 0, disposed: 0 };
  const ctx = {
    get(name) { return ctx[name]; },
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'host', model: 'default' }),
      async saveSelection() { calls.globalSave += 1; throw new Error('Global defaults must not be written'); },
    },
    llm: {
      listProviders: () => [{ id: 'host' }],
      async listModels() { return ['default', 'first', 'next', 'web'].map(id => ({ id })); },
      async resolveCallConfig(model) { return { ...model }; },
    },
    agentPresets: {
      async resolve(id) { calls.resolvePreset.push(id); return { id: id || 'host-default' }; },
      async mount(agentCtx, id) { assert.equal(agentCtx.protected, true); calls.mountPreset.push({ agentCtx, id }); },
    },
    sessions: {
      get: id => sessions.get(id),
      async flush(session) {
        persisted.set(session.id, { header: { ...session.header }, sizeBytes: 128, events: structuredClone(session.events) });
        return true;
      },
    },
    sessionPersistence: {
      async stat(id) { return persisted.get(id); },
      async open(id, access) {
        assert.equal(access, 'read');
        const stored = persisted.get(id);
        if (!stored) throw new Error('Not stored');
        return { header: stored.header, async read() { return { events: stored.events }; }, async close() {} };
      },
    },
    workspaceRegistry: {
      archivedSessionIds: [],
      get: id => workspaces.get(id),
      async create(directory) {
        const existing = [...workspaces.values()].find(item => item.path === directory);
        if (existing) return existing;
        const workspace = {
          id: `workspace-${workspaces.size}`, path: directory,
          async attachSession(id) { calls.attach += 1; assert.ok(sessions.has(id)); },
        };
        workspaces.set(workspace.id, workspace);
        return workspace;
      },
    },
    sessionController: {
      async inspect(id) {
        const session = sessions.get(id);
        if (!session) throw Object.assign(new Error('not found'), { code: 'session/not-found' });
        return { meta: session.header, events: session.events };
      },
    },
  };
  async function create(request, id = request.sessionId) {
    calls.create += 1;
    const session = {
      id, header: { id, ...request.meta }, events: [],
      append(type, data) { session.events.push({ type, data: structuredClone(data) }); },
    };
    const agent = { id, session, ctx: {}, options: request.agentOptions };
    const commit = await request.setup(agent.ctx, agent);
    commit?.commit();
    sessions.set(id, session);
    return { agent, async dispose() { calls.disposed += 1; sessions.delete(id); } };
  }
  ctx.agents = { create };
  const options = {
    file, ctx,
    resolveWorkspace(key) { calls.resolve += 1; return path.join(directory, key.replace(':', '_')); },
    setupAgent(agentCtx, _agent, { key }) { agentCtx.protected = true; calls.setup.push(key); },
  };
  return { file, ctx, sessions, persisted, workspaces, calls, create, options, read: async () => JSON.parse(await fs.readFile(file, 'utf8')) };
}

test('coalesces one QQ key and preserves concurrent records for different keys', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap(h.options);
  const [first, second, other] = await Promise.all([map.ensure('group:10'), map.ensure('group:10'), map.ensure('private:1')]);
  assert.deepEqual(first, second);
  assert.notEqual(first.sessionId, other.sessionId);
  assert.equal(h.calls.create, 2);
  assert.deepEqual(Object.keys((await h.read()).bindings).sort(), ['group:10', 'private:1']);
});

test('reopens an existing mapping and retains its Session and workspace', async (t) => {
  const h = await setup(t);
  const first = await (await createQQSessionMap(h.options)).ensure('group:10');
  const second = await (await createQQSessionMap(h.options)).ensure('group:10');
  assert.deepEqual(second, first);
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.resolve, 1);
});

test('an archived Session gets a new identity in the same workspace', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap(h.options);
  const first = await map.ensure('group:10');
  h.ctx.workspaceRegistry.archivedSessionIds.push(first.sessionId);
  const next = await map.ensure('group:10');
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(next.workspaceId, first.workspaceId);
  assert.equal(next.workspacePath, first.workspacePath);
});

test('records the returned identity and retries association without creating again', async (t) => {
  const h = await setup(t);
  h.ctx.agents.create = async request => {
    h.calls.create += 1;
    h.calls.create -= 1;
    return h.create(request, 'qq-session-different');
  };
  const createWorkspace = h.ctx.workspaceRegistry.create;
  let fail = true;
  h.ctx.workspaceRegistry.create = async directory => {
    const workspace = await createWorkspace(directory);
    workspace.attachSession = async () => { if (fail) throw new Error('association unavailable'); };
    return workspace;
  };
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('group:10'), /association unavailable/);
  assert.equal((await h.read()).bindings['group:10'].creating.returnedId, 'qq-session-different');
  fail = false;
  assert.equal((await (await createQQSessionMap(h.options)).ensure('group:10')).sessionId, 'qq-session-different');
  assert.equal(h.calls.create, 1);
});

test('creation error retains intent and does not blindly retry after reopening', async (t) => {
  const h = await setup(t);
  h.ctx.agents.create = async () => { h.calls.create += 1; throw new Error('response lost'); };
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  const pending = (await h.read()).bindings['private:1'].creating;
  assert.ok(pending.requestedId);
  assert.equal(pending.returnedId, null);
  await assert.rejects((await createQQSessionMap(h.options)).ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  assert.equal(h.calls.create, 1);
});

test('a lost create response can recover the requested Session by inspection', async (t) => {
  const h = await setup(t);
  const original = h.ctx.agents.create;
  h.ctx.agents.create = async request => { await original(request); throw new Error('response lost'); };
  await assert.rejects((await createQQSessionMap(h.options)).ensure('private:1'));
  const pending = (await h.read()).bindings['private:1'].creating;
  const recovered = await (await createQQSessionMap(h.options)).ensure('private:1');
  assert.equal(recovered.sessionId, pending.requestedId);
  assert.equal(h.calls.create, 1);
});

test('missing, corrupt or inaccessible existing Session never implies deletion', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap(h.options);
  const first = await map.ensure('private:1');
  h.sessions.delete(first.sessionId);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_RESTORE_FAILED' });
  h.sessions.set(first.sessionId, { id: first.sessionId, header: { id: first.sessionId }, events: [] });
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_RESTORE_FAILED' });
  h.ctx.sessionController.inspect = async () => { throw new Error('storage offline'); };
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_RESTORE_FAILED' });
  assert.equal(h.calls.create, 1);
  assert.equal((await h.read()).bindings['private:1'].sessionId, first.sessionId);
});

test('invalid files and workspace paths fail instead of resetting data', async (t) => {
  const h = await setup(t);
  await fs.writeFile(h.file, '{broken');
  await assert.rejects(createQQSessionMap(h.options), { code: 'QQ_SESSION_MAP_INVALID' });
  assert.equal(await fs.readFile(h.file, 'utf8'), '{broken');
  await fs.rm(h.file);
  const map = await createQQSessionMap({ ...h.options, resolveWorkspace: () => 'relative' });
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_WORKSPACE_INVALID' });
  await assert.rejects(map.ensure('private:../1'), { code: 'QQ_SESSION_KEY_INVALID' });
  assert.equal(h.calls.create, 0);
});

test('mapping write failure prevents Session creation', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap(h.options);
  await fs.mkdir(h.file);
  await assert.rejects(map.ensure('private:1'));
  assert.equal(h.calls.create, 0);
});

test('retains a different returned identity in memory when its journal write fails', async (t) => {
  const h = await setup(t);
  h.ctx.agents.create = async request => {
    h.calls.create += 1;
    h.calls.create -= 1;
    const handle = await h.create(request, 'qq-session-different');
    await fs.mkdir(`${h.file}.tmp`);
    return handle;
  };
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'));
  assert.equal((await h.read()).bindings['private:1'].creating.returnedId, null);
  await fs.rm(`${h.file}.tmp`, { recursive: true });
  assert.equal((await map.ensure('private:1')).sessionId, 'qq-session-different');
  assert.equal(h.calls.create, 1);
});

test('a Session durability failure retains creation intent for retry', async (t) => {
  const h = await setup(t);
  const flush = h.ctx.sessions.flush;
  h.ctx.sessions.flush = async () => false;
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  assert.ok((await h.read()).bindings['private:1'].creating.returnedId);
  assert.equal((await h.read()).bindings['private:1'].sessionId, null);
  h.ctx.sessions.flush = flush;
  await map.ensure('private:1');
  assert.equal(h.calls.create, 1);
});

test('the internal preset applies only on creation and is not reselected on reuse', async (t) => {
  const h = await setup(t);
  const original = h.ctx.agents.create;
  const requests = [];
  h.ctx.agents.create = async request => { requests.push(request); return original(request); };
  const map = await createQQSessionMap({ ...h.options, agentPreset: 'qq-restricted' });
  await map.ensure('private:1');
  await map.ensure('private:1');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].meta.agentPreset, 'qq-restricted');
  assert.deepEqual(h.calls.resolvePreset, ['qq-restricted']);
  assert.equal(h.calls.mountPreset[0].id, 'qq-restricted');
});

test('a participating flush listener without a persistence writer cannot activate a Session', async (t) => {
  const h = await setup(t);
  h.ctx.sessions.flush = async () => true;
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  const record = (await h.read()).bindings['private:1'];
  assert.equal(record.sessionId, null);
  assert.ok(record.creating.returnedId);
  assert.equal(h.persisted.size, 0);
  assert.equal(h.calls.attach, 0);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  assert.equal(h.calls.create, 1);
});

test('missing persistence service or mismatched stored header retains the creating record', async (t) => {
  const h = await setup(t);
  delete h.ctx.sessionPersistence;
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  h.ctx.sessionPersistence = { async stat() { return { header: { id: 'wrong', cwd: 'wrong' } }; } };
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  assert.equal((await h.read()).bindings['private:1'].sessionId, null);
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.attach, 0);
});

test('pending JSONL snapshots without physical size cannot activate a Session', async (t) => {
  const h = await setup(t);
  let sizeBytes;
  h.ctx.sessionPersistence.stat = async id => ({ ...h.persisted.get(id), sizeBytes });
  const map = await createQQSessionMap(h.options);
  for (sizeBytes of [undefined, 0, -1, Infinity, '128']) {
    await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  }
  assert.equal((await h.read()).bindings['private:1'].sessionId, null);
  assert.ok((await h.read()).bindings['private:1'].creating.returnedId);
  assert.equal(h.calls.attach, 0);
  sizeBytes = 128;
  assert.ok((await map.ensure('private:1')).sessionId);
  assert.equal(h.calls.create, 1);
});

test('creation snapshots and normalizes the selected model without changing global defaults', async (t) => {
  const h = await setup(t);
  let selected = { provider: 'host', model: 'first' };
  h.ctx.llm.resolveCallConfig = async model => ({ ...model, reasoningEffort: 'high', maxTokens: 200 });
  h.ctx.agents.create = async request => {
    const pending = (await h.read()).bindings['private:1'].creating;
    assert.deepEqual(pending.model, request.agentOptions);
    assert.deepEqual(pending.model, { provider: 'host', model: 'first', reasoningEffort: 'high' });
    assert.equal(pending.presetId, 'host-default');
    return h.create(request);
  };
  const map = await createQQSessionMap({ ...h.options, getDefaultModel: () => selected });
  const created = await map.ensure('private:1');
  const live = h.sessions.get(created.sessionId);
  assert.deepEqual(live.events, [{ type: 'model/selection', data: { provider: 'host', model: 'first', reasoningEffort: 'high' } }]);
  selected = { provider: 'host', model: 'next' };
  live.append('model/selection', { provider: 'host', model: 'web' });
  await map.ensure('private:1');
  assert.deepEqual(live.events.map(event => event.data.model), ['first', 'web']);
  assert.deepEqual(h.ctx.agentDefaultModel.currentSelection(), { provider: 'host', model: 'default' });
  assert.equal(h.calls.globalSave, 0);
  assert.equal(h.calls.create, 1);
});

test('empty plugin selection uses the host default only for a new Session', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap({ ...h.options, getDefaultModel: () => null });
  const created = await map.ensure('private:1');
  assert.equal(h.sessions.get(created.sessionId).events[0].data.model, 'default');
  assert.deepEqual(h.calls.resolvePreset, [undefined]);
  assert.equal(h.calls.mountPreset[0].id, 'host-default');
  assert.equal(h.calls.globalSave, 0);
});

test('invalid or unavailable configured models cannot create or activate a Session', async (t) => {
  const h = await setup(t);
  let selection = { provider: 'missing', model: 'first' };
  const map = await createQQSessionMap({ ...h.options, getDefaultModel: () => selection });
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_MODEL_UNAVAILABLE' });
  selection = { provider: 'host', model: 'missing' };
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_MODEL_UNAVAILABLE' });
  selection = { provider: 'host' };
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_MODEL_UNAVAILABLE' });
  selection = { provider: 'host', model: 'first' };
  h.ctx.llm.resolveCallConfig = async () => { throw new Error('invalid reasoning effort'); };
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_MODEL_UNAVAILABLE' });
  assert.equal(h.calls.create, 0);
  assert.equal((await h.read()).bindings['private:1'].sessionId, null);
});

test('recovery uses the persisted creating model snapshot after plugin settings change', async (t) => {
  const h = await setup(t);
  let selected = { provider: 'host', model: 'first' };
  let selections = 0;
  h.ctx.agents.create = async request => { await h.create(request); throw new Error('lost response'); };
  const options = { ...h.options, getDefaultModel: () => { selections += 1; return selected; } };
  await assert.rejects((await createQQSessionMap(options)).ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  selected = { provider: 'host', model: 'next' };
  const recovered = await (await createQQSessionMap(options)).ensure('private:1');
  assert.equal(h.sessions.get(recovered.sessionId).events[0].data.model, 'first');
  assert.equal(selections, 1);
  assert.equal(h.calls.create, 1);
});

test('a live model event is insufficient when the persisted event is missing', async (t) => {
  const h = await setup(t);
  const flush = h.ctx.sessions.flush;
  h.ctx.sessions.flush = async session => {
    persistedSnapshot(session);
    return true;
  };
  function persistedSnapshot(session) {
    h.persisted.set(session.id, { header: { ...session.header }, sizeBytes: 128, events: [] });
  }
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  assert.equal((await h.read()).bindings['private:1'].sessionId, null);
  assert.equal(h.calls.attach, 0);
  h.ctx.sessions.flush = flush;
  await map.ensure('private:1');
  assert.equal(h.calls.create, 1);
});

test('existing live Sessions still require a matching physical persistence record', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap(h.options);
  const created = await map.ensure('private:1');
  h.persisted.delete(created.sessionId);
  assert.ok(await h.ctx.sessionController.inspect(created.sessionId));
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_NOT_DURABLE' });
  assert.equal(h.calls.create, 1);
  assert.equal((await h.read()).bindings['private:1'].sessionId, created.sessionId);
});

test('preset mount failure rolls back publication and leaves creation uncertain', async (t) => {
  const h = await setup(t);
  h.ctx.agentPresets.mount = async () => { throw new Error('preset failed'); };
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  const pending = (await h.read()).bindings['private:1'].creating;
  assert.equal(pending.presetId, 'host-default');
  assert.equal(h.sessions.size, 0);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  assert.equal(h.calls.create, 1);
  assert.equal(h.calls.globalSave, 0);
});

test('an Agent protection hook is required before any mapping can be used', async (t) => {
  const h = await setup(t);
  await assert.rejects(createQQSessionMap({ ...h.options, setupAgent: undefined }), { code: 'QQ_AGENT_SETUP_REQUIRED' });
  assert.equal(h.calls.create, 0);
  await assert.rejects(fs.stat(h.file), { code: 'ENOENT' });
});

test('Agent protection failure prevents preset mounting and publication', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap({ ...h.options, setupAgent: () => { throw new Error('guard unavailable'); } });
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  assert.equal(h.sessions.size, 0);
  assert.equal(h.calls.mountPreset.length, 0);
  assert.equal(h.calls.attach, 0);
  assert.ok((await h.read()).bindings['private:1'].creating);
});

test('the protection hook publication commit is preserved for the native factory', async (t) => {
  const h = await setup(t);
  let committed = false;
  const map = await createQQSessionMap({
    ...h.options,
    setupAgent(agentCtx) {
      agentCtx.protected = true;
      return { commit() { committed = true; throw new Error('authorization changed before publication'); } };
    },
  });
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  assert.equal(committed, true);
  assert.equal(h.sessions.size, 0);
  assert.equal(h.calls.attach, 0);
});

test('a factory identity outside the QQ namespace is rejected and its owned handle is disposed', async (t) => {
  const h = await setup(t);
  h.ctx.agents.create = request => h.create(request, 'normal-dsh-session');
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  const record = (await h.read()).bindings['private:1'];
  assert.ok(record.creating.requestedId.startsWith('qq-session-'));
  assert.equal(record.creating.returnedId, null);
  assert.equal(record.sessionId, null);
  assert.equal(h.calls.disposed, 1);
  assert.equal(h.calls.attach, 0);
  await assert.rejects(map.ensure('private:1'), { code: 'QQ_SESSION_CREATE_UNKNOWN' });
  assert.equal(h.calls.create, 1);
});

test('loaded mappings reject non-QQ active, requested and returned identities', async (t) => {
  const h = await setup(t);
  await (await createQQSessionMap(h.options)).ensure('private:1');
  const stored = await h.read();
  const active = stored.bindings['private:1'];
  const pending = {
    requestedId: 'qq-session-pending', returnedId: null,
    model: { provider: 'host', model: 'default' }, presetId: 'host-default',
  };
  for (const record of [
    { ...active, sessionId: 'session-old-format' },
    { ...active, creating: { ...pending, requestedId: 'session-old-format' } },
    { ...active, creating: { ...pending, returnedId: 'normal-session' } },
  ]) {
    await fs.writeFile(h.file, JSON.stringify({ version: 1, bindings: { 'private:1': record } }));
    await assert.rejects(createQQSessionMap(h.options), { code: 'QQ_SESSION_MAP_INVALID' });
    assert.deepEqual((await h.read()).bindings['private:1'], record);
  }
});

test('lookup returns only committed unarchived native QQ bindings and fresh metadata copies', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap(h.options);
  const active = await map.ensure('private:1');
  const before = await fs.readFile(h.file, 'utf8');
  assert.deepEqual(map.lookupBySessionId(active.sessionId), active);
  for (const id of [null, undefined, '', 'normal-session', 'qq-session-unknown']) assert.equal(map.lookupBySessionId(id), null);
  const copy = map.lookupBySessionId(active.sessionId);
  copy.key = 'group:999';
  copy.workspaceId = 'other';
  copy.workspacePath = '/other';
  copy.sessionId = 'qq-session-other';
  assert.deepEqual(map.lookupBySessionId(active.sessionId), active);
  const reopened = await createQQSessionMap(h.options);
  assert.deepEqual(reopened.lookupBySessionId(active.sessionId), active);
  h.ctx.workspaceRegistry.archivedSessionIds.push(active.sessionId);
  assert.equal(map.lookupBySessionId(active.sessionId), null);
  assert.equal(reopened.lookupBySessionId(active.sessionId), null);
  assert.equal(await fs.readFile(h.file, 'utf8'), before);
  assert.equal(h.calls.create, 1);
});

test('lookup never exposes requested or returned creation candidates before activation', async (t) => {
  const h = await setup(t);
  const createWorkspace = h.ctx.workspaceRegistry.create;
  h.ctx.workspaceRegistry.create = async directory => {
    const workspace = await createWorkspace(directory);
    workspace.attachSession = async () => { throw new Error('association pending'); };
    return workspace;
  };
  const map = await createQQSessionMap(h.options);
  await assert.rejects(map.ensure('private:1'), /association pending/);
  const record = (await h.read()).bindings['private:1'];
  assert.equal(record.sessionId, null);
  assert.equal(map.lookupBySessionId(record.creating.requestedId), null);
  assert.equal(map.lookupBySessionId(record.creating.returnedId), null);
});

test('lookup fails closed for an ambiguous ID or unreadable archive status', async (t) => {
  const h = await setup(t);
  const map = await createQQSessionMap(h.options);
  const active = await map.ensure('private:1');
  const stored = await h.read();
  stored.bindings['group:2'] = { ...stored.bindings['private:1'] };
  await fs.writeFile(h.file, JSON.stringify(stored));
  assert.equal((await createQQSessionMap(h.options)).lookupBySessionId(active.sessionId), null);
  Object.defineProperty(h.ctx.workspaceRegistry, 'archivedSessionIds', { get() { throw new Error('registry unavailable'); } });
  assert.equal(map.lookupBySessionId(active.sessionId), null);
});
