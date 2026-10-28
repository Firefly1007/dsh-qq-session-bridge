import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { QQ_SESSION_PREFIX, isQQSessionId } from './qq-root-guard.js';

function failure(code, message, cause) {
  return Object.assign(new Error(message, cause === undefined ? undefined : { cause }), { code });
}

function validModel(model) {
  return model && typeof model === 'object' && !Array.isArray(model) && typeof model.provider === 'string' && model.provider
    && typeof model.model === 'string' && model.model
    && (model.reasoningEffort === undefined || (typeof model.reasoningEffort === 'string' && model.reasoningEffort));
}

function sameModel(left, right) {
  return left?.provider === right.provider && left?.model === right.model && left?.reasoningEffort === right.reasoningEffort;
}

function validateRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || !path.isAbsolute(record.workspacePath) || typeof record.workspaceId !== 'string' || !record.workspaceId
    || (record.sessionId !== null && !isQQSessionId(record.sessionId))) return false;
  if (record.creating === null) return true;
  const pending = record.creating;
  return pending && typeof pending === 'object' && isQQSessionId(pending.requestedId)
    && (pending.returnedId === null || isQQSessionId(pending.returnedId))
    && validModel(pending.model) && (pending.presetId === null || (typeof pending.presetId === 'string' && pending.presetId));
}

/** Map QQ identities to native Sessions; existing Agents keep their model and preset. */
// shortcut: one map instance owns each file; add interprocess locking if multiple hosts share it.
export async function createQQSessionMap({ file, ctx, resolveWorkspace, agentPreset, getDefaultModel, setupAgent }) {
  if (typeof setupAgent !== 'function') throw failure('QQ_AGENT_SETUP_REQUIRED', 'QQ Agent protection must be installed before publication');
  let db = { version: 1, bindings: {} };
  try {
    const stored = JSON.parse(await fs.readFile(file, 'utf8'));
    if (stored.version !== 1 || !stored.bindings || typeof stored.bindings !== 'object' || Array.isArray(stored.bindings)
      || Object.entries(stored.bindings).some(([key, record]) => !/^(private|group):[1-9]\d*$/.test(key) || !validateRecord(record))) {
      throw new Error('Invalid QQ Session mapping');
    }
    db = stored;
  } catch (error) {
    if (error.code !== 'ENOENT') throw failure('QQ_SESSION_MAP_INVALID', 'Cannot read QQ Session mapping', error);
  }

  const inflight = new Map();
  const uncommitted = new Map();
  let writes = Promise.resolve();

  function save(key, record) {
    const operation = writes.then(async () => {
      const next = { version: 1, bindings: { ...db.bindings, [key]: record } };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(`${file}.tmp`, JSON.stringify(next), { mode: 0o600 });
      await fs.rename(`${file}.tmp`, file);
      db = next;
      return record;
    });
    writes = operation.catch(() => {});
    return operation;
  }

  function archived(sessionId) {
    return ctx.workspaceRegistry.archivedSessionIds.includes(sessionId);
  }

  async function inspect(sessionId, workspacePath, code) {
    let result;
    try { result = await ctx.sessionController.inspect(sessionId); }
    catch (error) { throw failure(code, `Cannot confirm Session ${sessionId}; binding retained`, error); }
    if (result?.meta?.id !== sessionId || result.meta.cwd !== workspacePath) {
      throw failure(code, `Session ${sessionId} identity or workspace does not match; binding retained`);
    }
  }

  function value(key, record) {
    return { key, workspaceId: record.workspaceId, workspacePath: record.workspacePath, sessionId: record.sessionId };
  }

  async function workspaceFor(key, record) {
    if (record) {
      const existing = ctx.workspaceRegistry.get(record.workspaceId);
      if (existing) {
        if (existing.path !== record.workspacePath) throw failure('QQ_WORKSPACE_CONFLICT', 'QQ workspace identity changed');
        return existing;
      }
      return ctx.workspaceRegistry.create(record.workspacePath);
    }
    const directory = await resolveWorkspace(key);
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
      throw failure('QQ_WORKSPACE_INVALID', 'QQ workspace resolver must return an absolute directory');
    }
    await fs.mkdir(directory, { recursive: true });
    return ctx.workspaceRegistry.create(directory);
  }

  async function verifyStored(sessionId, workspacePath, model) {
    let stored;
    try {
      const persistence = ctx.sessionPersistence;
      if (!persistence || typeof persistence.stat !== 'function') throw new Error('Session persistence is unavailable');
      stored = await persistence.stat(sessionId);
    } catch (error) {
      throw failure('QQ_SESSION_NOT_DURABLE', 'Cannot confirm stored QQ Session; creation record retained', error);
    }
    if (stored?.header?.id !== sessionId || stored.header.cwd !== workspacePath) {
      throw failure('QQ_SESSION_NOT_DURABLE', 'Stored QQ Session identity or workspace does not match; creation record retained');
    }
    // shortcut: require JSONL's physical size; other backends need their own verified durability proof.
    if (!Number.isFinite(stored.sizeBytes) || stored.sizeBytes <= 0) {
      throw failure('QQ_SESSION_NOT_DURABLE', 'QQ Session persistence has not confirmed a materialized JSONL artifact; creation record retained');
    }
    if (model) {
      let handle;
      try {
        handle = await ctx.sessionPersistence.open(sessionId, 'read');
        const body = await handle.read();
        if (handle.header.id !== sessionId || handle.header.cwd !== workspacePath
          || !body.events.some(event => event.type === 'model/selection' && sameModel(event.data, model))) {
          throw new Error('Initial model selection was not persisted');
        }
      } catch (error) {
        throw failure('QQ_SESSION_NOT_DURABLE', 'Cannot confirm the stored initial QQ model; creation record retained', error);
      } finally { if (handle) await handle.close(); }
    }
  }

  async function finish(key, record, workspace) {
    const sessionId = record.creating.returnedId || record.creating.requestedId;
    if (archived(sessionId)) throw failure('QQ_SESSION_CREATE_ARCHIVED', 'Pending QQ Session was archived; creation record retained');
    await inspect(sessionId, record.workspacePath, 'QQ_SESSION_CREATE_UNKNOWN');
    const live = ctx.sessions.get(sessionId);
    if (live && !await ctx.sessions.flush(live)) {
      throw failure('QQ_SESSION_NOT_DURABLE', 'QQ Session has no durability listener; creation record retained');
    }
    await verifyStored(sessionId, record.workspacePath, record.creating.model);
    await workspace.attachSession(sessionId);
    const active = { ...record, sessionId, creating: null };
    await save(key, active);
    return value(key, active);
  }

  async function ensure(key) {
    if (uncommitted.has(key)) {
      await save(key, uncommitted.get(key));
      uncommitted.delete(key);
    }
    let record = db.bindings[key];
    const workspace = await workspaceFor(key, record);
    if (!record || record.workspaceId !== workspace.id) {
      record = await save(key, {
        workspacePath: workspace.path, workspaceId: workspace.id,
        sessionId: record?.sessionId || null, creating: record?.creating || null,
      });
    }
    if (record.creating) return finish(key, record, workspace);
    if (record.sessionId && !archived(record.sessionId)) {
      await inspect(record.sessionId, record.workspacePath, 'QQ_SESSION_RESTORE_FAILED');
      await verifyStored(record.sessionId, record.workspacePath);
      await workspace.attachSession(record.sessionId);
      return value(key, record);
    }

    let model;
    try {
      const requested = (await getDefaultModel?.()) || ctx.agentDefaultModel.currentSelection();
      if (!validModel(requested) || !ctx.llm.listProviders().some(provider => provider.id === requested.provider)
        || !(await ctx.llm.listModels(requested.provider)).some(item => item.id === requested.model)) {
        throw new Error('Configured QQ model is unavailable');
      }
      const resolved = await ctx.llm.resolveCallConfig(requested);
      model = {
        provider: resolved.provider, model: resolved.model,
        ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }),
      };
      if (!validModel(model)) throw new Error('Resolved QQ model is invalid');
    } catch (error) { throw failure('QQ_MODEL_UNAVAILABLE', 'Cannot select the initial QQ model', error); }
    const presets = ctx.get('agentPresets');
    if (!presets && agentPreset !== undefined) throw failure('QQ_PRESET_UNAVAILABLE', 'Agent preset registry is unavailable');
    const presetId = presets ? (await presets.resolve(agentPreset)).id : null;
    if (presetId !== null && (typeof presetId !== 'string' || !presetId)) {
      throw failure('QQ_PRESET_UNAVAILABLE', 'Agent preset registry returned no identity');
    }
    record = await save(key, { ...record, creating: { requestedId: `${QQ_SESSION_PREFIX}${randomUUID()}`, returnedId: null, model, presetId } });
    let handle;
    try {
      handle = await ctx.agents.create({
        sessionId: record.creating.requestedId,
        agentOptions: record.creating.model,
        meta: { cwd: record.workspacePath, ...(presetId === null ? {} : { agentPreset: presetId }) },
        setup: async (agentCtx, agent) => {
          const commit = await setupAgent(agentCtx, agent, { key });
          if (presetId !== null) await presets.mount(agentCtx, presetId);
          agent.session.append('model/selection', record.creating.model);
          return commit;
        },
      });
    } catch (error) {
      throw failure('QQ_SESSION_CREATE_UNKNOWN', 'QQ Session creation did not complete; creation record retained', error);
    }
    if (!handle?.agent || !isQQSessionId(handle.agent.id)) {
      if (typeof handle?.dispose === 'function') await handle.dispose();
      throw failure('QQ_SESSION_CREATE_UNKNOWN', 'QQ Session creation returned no Session identity; creation record retained');
    }
    record = { ...record, creating: { ...record.creating, returnedId: handle.agent.id } };
    // Capture a different returned id even if the mapping write fails in this process.
    uncommitted.set(key, record);
    await save(key, record);
    uncommitted.delete(key);
    return finish(key, record, workspace);
  }

  return {
    lookupBySessionId(sessionId) {
      if (!isQQSessionId(sessionId)) return null;
      const matches = Object.entries(db.bindings).filter(([, record]) => record.sessionId === sessionId && record.creating === null);
      if (matches.length !== 1) return null;
      try { return archived(sessionId) ? null : value(...matches[0]); }
      catch { return null; }
    },
    ensure(key) {
      if (!/^(private|group):[1-9]\d*$/.test(key)) return Promise.reject(failure('QQ_SESSION_KEY_INVALID', 'Invalid QQ Session key'));
      if (inflight.has(key)) return inflight.get(key);
      const operation = ensure(key).finally(() => { inflight.delete(key); });
      inflight.set(key, operation);
      return operation;
    },
  };
}
