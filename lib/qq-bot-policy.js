const WEB_TOOLS = new Set(['web_search', 'web_fetch']);
const QQ_TOOLS = new Set(['qq_send_text', 'qq_send_voice', 'qq_send_file', 'qq_read_attachment']);
const CONTROL_TOOLS = new Set(['qq_delegate', 'send_message', 'interrupt_agent']);

/** Policy for bot preset tools; the host owns registrations and removes them on teardown. */
export function createQQBotPolicy(ctx) {
  const roots = new WeakMap();
  const byId = new Map();
  function live(agent) { return !!agent && ctx.agents.get(agent.id) === agent; }
  function bot(agent) { return ctx.agentPresets.composedPreset(agent.ctx) === 'bot'; }
  return {
    registerRoot(agent, authorization) {
      if (!agent || !isQQSessionId(agent.id) || agent.session?.header?.id !== agent.id
        || agent.session.header.origin !== undefined || agent.session.header.parentSession !== undefined
        || typeof authorization?.canSend !== 'function' || typeof authorization.canDelegate !== 'function') {
        throw new TypeError('QQ root and authorization are required');
      }
      roots.set(agent, authorization);
      byId.set(agent.id, agent);
    },
    revokeRoot(agent) {
      roots.delete(agent);
      if (byId.get(agent?.id) === agent) byId.delete(agent.id);
    },
    checkBotTool(execution) {
      try {
        const agent = execution?.agent;
        if (!live(agent) || !bot(agent)) return 'Bot mode Agent is not ready';
        const authorization = roots.get(agent);
        if (authorization && byId.get(agent.id) === agent) {
          if (WEB_TOOLS.has(execution.name)) return;
          if (QQ_TOOLS.has(execution.name) && authorization.canSend()) return;
          if (CONTROL_TOOLS.has(execution.name) && authorization.canDelegate()) return;
          return 'Bot mode tool is not authorized for this QQ turn';
        }
        return 'Bot mode Agent is not authorized';
      } catch {
        return 'Bot mode authorization unavailable';
      }
    },
  };
}
import { isQQSessionId } from './qq-root-guard.js';

