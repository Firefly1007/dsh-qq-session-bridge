/** Keep QQ Sessions on the two user-selected native permission presets. */
export function ensureQQPermission(ctx, agent, { newSession = false } = {}) {
  const presets = ctx?.permissionPresets;
  if (typeof presets?.current !== 'function' || typeof presets.set !== 'function' || !agent?.session) {
    throw new Error('QQ 会话权限服务不可用');
  }
  const before = presets.current(agent.session);
  if (newSession || before !== 'danger-full-access') presets.set(agent.session, 'auto');
  const after = presets.current(agent.session);
  if ((newSession && after !== 'auto') || !['auto', 'danger-full-access'].includes(after)) {
    throw new Error('无法确认 QQ 会话的权限模式');
  }
  return after;
}
