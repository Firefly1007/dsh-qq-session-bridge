import { isQQSessionId } from './qq-root-guard.js';
import { createQQAuthorization } from './qq-authorization.js';
import { createQQBotPolicy } from './qq-bot-policy.js';
import { createQQPromptBridge } from './qq-prompt.js';
import { createQQSendQueue, registerQQTextTool, QQ_TEXT_TOOL } from './qq-text-tool.js';
import { registerQQVoiceTool, QQ_VOICE_TOOL } from './qq-voice-tool.js';
import { registerQQFileTool, QQ_FILE_TOOL } from './qq-file-tool.js';
import { registerQQDelegateTool, QQ_DELEGATE_TOOL } from './qq-delegate-tool.js';
import { ensureQQPermission } from './qq-permissions.js';
import { registerQQReadAttachment, QQ_READ_ATTACHMENT } from './qq-read-attachment.js';

const INHERITED = ['web_search', 'web_fetch', 'send_message', 'interrupt_agent'];
const CONTROLS = [QQ_DELEGATE_TOOL, 'send_message', 'interrupt_agent'];
const ALLOWED = [...INHERITED, QQ_TEXT_TOOL, QQ_VOICE_TOOL, QQ_FILE_TOOL, QQ_READ_ATTACHMENT, QQ_DELEGATE_TOOL];

function isRoot(agent) {
  const header = agent?.session?.header;
  return isQQSessionId(agent?.id) && header?.id === agent.id && header.origin === undefined
    && header.parentSession === undefined && (header.delegationDepth === undefined || header.delegationDepth === 0)
    && header.isSeeded !== true;
}

function sameBinding(left, right) {
  return left && right && ['key', 'sessionId', 'workspaceId', 'workspacePath'].every(key => left[key] === right[key]);
}

/** Coordinate one plugin lifetime; the supplied root guard belongs to the host. */
export function createQQAgentBindings({ ctx, rootGuard, lookupBySessionId, getConfig, nap, snapshotStore, synthesize, log = console, onTurnFinished }) {
  if (typeof ctx?.on !== 'function' || typeof ctx.provide !== 'function'
    || typeof ctx.agents?.get !== 'function' || typeof ctx.agents.list !== 'function' || typeof ctx.tools?.schemas !== 'function'
    || typeof ctx.agentPresets?.composedPreset !== 'function' || typeof rootGuard?.setPolicy !== 'function'
    || typeof rootGuard.revoke !== 'function' || typeof lookupBySessionId !== 'function'
    || typeof getConfig !== 'function' || typeof nap?.sendAction !== 'function'
    || !snapshotStore || !['stage', 'markPending', 'settle'].every(key => typeof snapshotStore[key] === 'function')) {
    throw new TypeError('QQ Agent binding dependencies are unavailable');
  }
  if (ctx.get('qqBotBridge')) throw new Error('A QQ bot bridge is already registered');
  const policy = createQQBotPolicy(ctx);
  const entries = new Map();
  const byId = new Map();
  const retired = new WeakSet();
  let stopped = false;

  function administrators() {
    const config = getConfig();
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || (config.superUsers !== undefined && typeof config.superUsers !== 'string')) throw new Error('Invalid QQ configuration');
    const ids = [...new Set(String(config.superUsers || '').split(/[\s,，]+/).filter(Boolean))].sort();
    if (ids.some(id => !/^[1-9]\d*$/.test(id))) throw new Error('Invalid QQ administrator identities');
    return ids;
  }

  function syncAdministrators(entry) {
    const ids = administrators();
    if (ids.length !== entry.administrators.length || ids.some((id, index) => id !== entry.administrators[index])) {
      entry.authorization.setAdministratorIds(ids);
      entry.administrators = ids;
    }
  }

  function deactivate(entry) {
    entry.ready = false;
    rootGuard.revoke(entry.agent);
    policy.revokeRoot(entry.agent);
    entry.activity.abort();
    for (const id of entry.sources) entry.authorization?.invalidate(id);
    entry.sources.clear();
  }

  function current(entry) {
    if (stopped || entry.closed || !entry.ready) return false;
    try {
      if (!isRoot(entry.agent) || ctx.agents.get(entry.agent.id) !== entry.agent
        || ctx.agentPresets.composedPreset(entry.agent.ctx) !== 'bot'
        || !sameBinding(entry.binding, lookupBySessionId(entry.agent.id))
        || entry.agent.session.header.cwd !== entry.binding.workspacePath) {
        deactivate(entry);
        return false;
      }
      syncAdministrators(entry);
      return true;
    } catch {
      deactivate(entry);
      return false;
    }
  }

  function cleanupAgent(agent) {
    const entry = entries.get(agent);
    if (!entry || entry.closed) return;
    entry.closed = true;
    deactivate(entry);
    entry.queue?.stop();
    for (const dispose of entry.disposers.reverse()) {
      try { dispose(); } catch { /* All remaining permissions still have to close. */ }
    }
    entries.delete(agent);
    if (byId.get(agent.id) === agent) byId.delete(agent.id);
    retired.add(agent);
  }

  function prepare(agentCtx, agent, { key }) {
    if (stopped || retired.has(agent) || !isRoot(agent) || agentCtx !== agent.ctx
      || typeof agentCtx.effect !== 'function' || !/^(private|group):[1-9]\d*$/.test(key)) {
      throw new Error('Cannot prepare this QQ root Agent');
    }
    const live = ctx.agents.get(agent.id);
    if (live && live !== agent) throw new Error('A different live Agent owns this QQ Session');
    const previous = byId.get(agent.id);
    if (previous && previous !== agent) {
      if (live !== agent) throw new Error('Another QQ Agent is still being prepared');
      cleanupAgent(previous);
    }
    const found = entries.get(agent);
    if (found) {
      if (found.key !== key) throw new Error('QQ Agent target cannot change');
      return found;
    }
    const ids = administrators();
    const entry = { agent, key, ready: false, closed: false, administrators: ids,
      activity: new AbortController(), sources: new Set(), disposers: [] };
    entries.set(agent, entry);
    byId.set(agent.id, agent);
    rootGuard.revoke(agent);
    try {
      const globalNames = new Set(ctx.tools.schemas().map(tool => tool.name));
      const unrestrict = agentCtx.tools.restrict({ allow: INHERITED.filter(name => globalNames.has(name)) });
      if (typeof unrestrict === 'function') entry.disposers.push(unrestrict);
      const unguard = agentCtx.tools.guard(execution => execution.agent === agent
        ? current(entry) ? policy.checkBotTool(execution) : 'QQ root binding is not active'
        : undefined);
      if (typeof unguard === 'function') entry.disposers.push(unguard);
      agentCtx.effect(() => () => cleanupAgent(agent), 'qq-agent-bindings cleanup');
      entry.disposers.push(agentCtx.on('session/event', (session, event) => {
        if (session === agent.session && event.type === 'turn/start') {
          entry.turn = { id: event.data.turn, sent: false, voiceUnknown: false, unknown: false, messageIds: new Set() };
        } else if (session === agent.session && event.type === 'turn/end' && entry.turn?.id === event.data.turn) {
          try { onTurnFinished?.({ key: entry.key, agent, ...entry.turn, reason: event.data.reason }); } catch { /* Observers are independent. */ }
        }
      }));
      entry.disposers.push(agentCtx.on('agent/inbox/claimed', ({ agent: subject, message }) => {
        if (subject === agent && entry.turn && typeof message?.id === 'string') entry.turn.messageIds.add(message.id);
      }));
      entry.authorization = createQQAuthorization({ agent, controlTools: CONTROLS, administratorIds: ids, removeGuardOnDispose: true,
        onTurnEnd(outcome) {
          const turn = entry.turn;
          if (turn && turn.id === outcome.turn && outcome.origin === 'reminder' && outcome.sendable
            && outcome.reason?.kind !== 'aborted' && !turn.sent) {
            try { log.warn('[napcat] QQ 漏发送提醒后仍未确认发送成功'); } catch { /* Logging must not change authorization. */ }
          }
          if (!turn || turn.id !== outcome.turn || !outcome.sendable || outcome.origin !== 'qq'
            || outcome.reason?.kind === 'aborted' || turn.sent || turn.voiceUnknown) return;
          queueMicrotask(() => {
            if (!current(entry) || !entry.prompt) return;
            const text = turn.unknown
              ? '上一轮 QQ 发送状态未确认，可能已送达。请根据实际情况决定是否再次调用 QQ 发送工具；避免无必要的重复。'
              : '上一轮没有成功向 QQ 发送内容。请调用 QQ 发送工具回应；若无法发送，请说明原因。';
            entry.prompt.remind({ mode: 'queue', content: [{ type: 'text', text }] }).then(result => {
              if (result.status !== 'accepted') try { log.warn('[napcat] QQ 漏发送提醒未确认入队'); } catch { /* ignore */ }
            }).catch(() => { try { log.warn('[napcat] QQ 漏发送提醒提交失败'); } catch { /* ignore */ } });
          });
        },
      });
      entry.disposers.push(() => entry.authorization.dispose());
      if (typeof entry.authorization.setAdministratorIds !== 'function') throw new Error('QQ administrator updates are unavailable');
      const authorization = {
        admit(...args) {
          if (!current(entry)) throw new Error('QQ root binding is not active');
          entry.authorization.admit(...args);
          entry.sources.add(args[0].id);
        },
        admitProactive(...args) {
          if (!current(entry)) throw new Error('QQ root binding is not active');
          entry.authorization.admitProactive(...args);
          entry.sources.add(args[0].id);
        },
        admitReminder(...args) {
          if (!current(entry)) throw new Error('QQ root binding is not active');
          entry.authorization.admitReminder(...args);
          entry.sources.add(args[0].id);
        },
        invalidate(id) { entry.sources.delete(id); return entry.authorization.invalidate(id); },
        canSend(permit) { return current(entry) && entry.authorization.canSend(permit); },
        captureSendPermit() { return current(entry) ? entry.authorization.captureSendPermit() : null; },
        canDelegate() { return current(entry) && entry.authorization.canDelegate(); },
        resolveQQFile(id, permit) { return current(entry) ? entry.authorization.resolveQQFile(id, permit) : null; },
      };
      entry.facade = authorization;
      entry.queue = createQQSendQueue({ agent, authorization });
      const channel = { type: key.startsWith('group:') ? 'group' : 'private', id: key.split(':')[1] };
      const transport = {
        callAction: (...args) => nap.callAction(...args),
        async sendAction(action, params, options = {}) {
          if (!current(entry)) return Promise.resolve({ status: 'failed', code: 'QQ_BINDING_UNAVAILABLE', message: 'QQ binding is not active' });
          const signal = options.signal ? AbortSignal.any([options.signal, entry.activity.signal]) : entry.activity.signal;
          const turn = entry.turn;
          let result;
          try { result = await nap.sendAction(action, params, { ...options, signal }); }
          catch { result = { status: 'unknown', code: 'SEND_RESULT_UNKNOWN', message: 'QQ 发送状态未知。' }; }
          if (turn) {
            if (result?.status === 'sent') turn.sent = true;
            else if (result?.status !== 'failed') {
              if (Array.isArray(params?.message) && params.message.some(part => part?.type === 'record')) turn.voiceUnknown = true;
              else turn.unknown = true;
            }
          }
          return result;
        },
      };
      entry.disposers.push(registerQQTextTool({ agent, sendQueue: entry.queue, nap: transport, channel }));
      entry.disposers.push(registerQQVoiceTool({ agent, sendQueue: entry.queue, nap: transport, channel,
        config: new Proxy({}, { get: (_target, property) => getConfig()?.[property] }),
        ...(synthesize === undefined ? {} : { synthesize }) }));
      entry.disposers.push(registerQQFileTool({ agent, sendQueue: entry.queue, nap: transport, channel,
        workspacePath: agent.session.header.cwd, snapshotStore }));
      entry.disposers.push(registerQQReadAttachment({ agent, authorization, attachments: ctx.attachments }));
      entry.disposers.push(registerQQDelegateTool({ agent, authorization, ctx }));
      const bridge = createQQPromptBridge({ ctx, agent, authorization });
      entry.disposers.push(() => bridge.dispose());
      const submit = (method, request, signal) => {
        if (!current(entry)) return Promise.resolve({ status: 'failed', inserted: false, authorized: false,
          code: 'QQ_BINDING_UNAVAILABLE', message: 'QQ 会话绑定不可用，未提交原生输入。' });
        try { ensureQQPermission(ctx, agent); }
        catch {
          deactivate(entry);
          return Promise.resolve({ status: 'failed', inserted: false, authorized: false,
            code: 'QQ_PERMISSION_UNAVAILABLE', message: 'QQ 会话权限模式不可用，未提交原生输入。' });
        }
        let combined;
        try { combined = signal ? AbortSignal.any([signal, entry.activity.signal]) : entry.activity.signal; }
        catch { return Promise.resolve({ status: 'failed', inserted: false, authorized: false, code: 'INVALID_SIGNAL', message: '取消信号无效。' }); }
        return bridge[method](request, combined);
      };
      entry.prompt = {
        prompt: (request, signal) => submit('prompt', request, signal),
        proactive: (request, signal) => submit('proactive', request, signal),
        remind: (request, signal) => submit('remind', request, signal),
      };
      return entry;
    } catch (error) {
      cleanupAgent(agent);
      throw error;
    }
  }

  function activate(agent, binding) {
    const entry = entries.get(agent);
    if (stopped || !entry || entry.closed || entry.awaitingCommit) return false;
    try {
      const actual = lookupBySessionId(agent.id);
      if (!isRoot(agent) || ctx.agents.get(agent.id) !== agent || !binding || !sameBinding(binding, actual)
        || binding.sessionId !== agent.id || binding.key !== entry.key || !binding.workspaceId
        || binding.workspacePath !== agent.session.header.cwd || ctx.agentPresets.composedPreset(agent.ctx) !== 'bot') {
        deactivate(entry);
        return false;
      }
      syncAdministrators(entry);
      if (entry.activity.signal.aborted) entry.activity = new AbortController();
      entry.binding = { key: binding.key, sessionId: binding.sessionId, workspaceId: binding.workspaceId, workspacePath: binding.workspacePath };
      policy.registerRoot(agent, entry.facade);
      entry.ready = true;
      rootGuard.setPolicy(agent, ALLOWED);
      return true;
    } catch {
      deactivate(entry);
      return false;
    }
  }

  function observe(agent) {
    if (!isQQSessionId(agent?.id)) return;
    try {
      const binding = lookupBySessionId(agent.id);
      if (!binding || !isRoot(agent) || ctx.agentPresets.composedPreset(agent.ctx) !== 'bot') {
        const entry = entries.get(agent);
        if (entry) deactivate(entry);
        else rootGuard.revoke(agent);
        return;
      }
      prepare(agent.ctx, agent, { key: binding.key });
      activate(agent, binding);
    } catch { cleanupAgent(agent); rootGuard.revoke(agent); }
  }

  const api = {
    setupAgent(agentCtx, agent, meta) {
      const entry = prepare(agentCtx, agent, meta);
      entry.awaitingCommit = true;
      return { commit() {
        try {
          if (stopped || entry.closed || ctx.agentPresets.composedPreset(agentCtx) !== 'bot') throw new Error('QQ Agent must be in bot mode before publication');
          ensureQQPermission(ctx, agent, { newSession: true });
          syncAdministrators(entry);
          entry.awaitingCommit = false;
        } catch (error) { cleanupAgent(agent); throw error; }
      } };
    },
    activate,
    getPromptBridge(agent) { const entry = entries.get(agent); return entry && current(entry) ? entry.prompt : null; },
    cleanupAgent,
    checkBotTool(execution) {
      const entry = entries.get(execution?.agent);
      return entry && current(entry) ? policy.checkBotTool(execution) : 'QQ bot binding is unavailable';
    },
    refresh() { if (!stopped) for (const agent of ctx.agents.list()) observe(agent); },
    dispose() {
      if (stopped) return;
      stopped = true;
      stopCreated();
      stopDisposed();
      for (const agent of [...entries.keys()]) cleanupAgent(agent);
      stopService();
    },
  };
  const stopService = ctx.provide('qqBotBridge', api);
  const stopCreated = ctx.on('agent/created', ({ agent }) => { if (!stopped) observe(agent); });
  const stopDisposed = ctx.on('agent/disposed', ({ agent }) => cleanupAgent(agent));
  api.refresh();
  return api;
}
