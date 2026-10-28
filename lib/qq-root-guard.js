export const QQ_SESSION_PREFIX = 'qq-session-';
const HOST_GUARDS = Symbol.for('dsh-qq-session-bridge.qq-root-guards');

export function isQQSessionId(id) {
  return typeof id === 'string' && id.startsWith(QQ_SESSION_PREFIX) && id.length > QQ_SESSION_PREFIX.length;
}

function classify(agent) {
  const header = agent?.session?.header;
  const inNamespace = id => typeof id === 'string' && id.startsWith(QQ_SESSION_PREFIX);
  if (!inNamespace(agent?.id) && !inNamespace(header?.id)) return 'other';
  return isQQSessionId(agent?.id) && header?.id === agent.id
    && header.origin === undefined && header.parentSession === undefined
    && (header.delegationDepth === undefined || header.delegationDepth === 0)
    && header.isSeeded !== true ? 'root' : 'invalid';
}

/** Install on the host lifetime context; clearing policy never unregisters this guard. */
export function createQQRootGuard(hostCtx) {
  let policies = new WeakMap();
  let stopped = false;
  hostCtx.tools.guard((execution) => {
    const kind = classify(execution.agent);
    if (kind === 'other') return undefined;
    if (kind === 'invalid' || stopped) return 'QQ root Agent is unavailable';
    try {
      const presets = hostCtx.get('agentPresets');
      if (!presets || presets.composedPreset(execution.agent.ctx) !== 'bot') return 'QQ root Agent is not in bot mode';
    } catch {
      return 'QQ root Agent preset is unavailable';
    }
    return policies.get(execution.agent)?.has(execution.name) ? undefined : 'QQ root tool is not authorized';
  });
  return {
    setPolicy(agent, allowedNames) {
      if (stopped) throw new Error('QQ root guard is stopped');
      if (classify(agent) !== 'root') throw new Error('Expected a QQ root Agent with matching root lineage');
      if ((!Array.isArray(allowedNames) && !(allowedNames instanceof Set))
        || [...allowedNames].some(name => typeof name !== 'string' || !name)) {
        throw new TypeError('QQ root policy must be a list of tool names');
      }
      policies.set(agent, new Set(allowedNames));
    },
    revoke(agent) { policies.delete(agent); },
    clear() { policies = new WeakMap(); },
    stop() { stopped = true; policies = new WeakMap(); },
  };
}

/** A disabled bridge leaves its host guard installed with an empty policy. */
export function getQQHostGuard(hostCtx) {
  if (!hostCtx || typeof hostCtx !== 'object' || typeof hostCtx.tools?.guard !== 'function') {
    throw new TypeError('Host tool guard is unavailable');
  }
  const guards = globalThis[HOST_GUARDS] ||= new WeakMap();
  let guard = guards.get(hostCtx);
  if (!guard) {
    guard = createQQRootGuard(hostCtx);
    guards.set(hostCtx, guard);
  }
  return guard;
}
