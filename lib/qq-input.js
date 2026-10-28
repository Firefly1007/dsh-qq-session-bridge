function qqId(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return '';
  const id = String(value);
  return /^[1-9]\d*$/.test(id) ? id : '';
}

function decodeCQ(value) {
  return value.replace(/&#44;/g, ',').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&');
}

function cqSegments(message) {
  const segments = [];
  let end = 0;
  for (const match of message.matchAll(/\[CQ:([a-z_]+)((?:,[^\]]*)?)\]/gi)) {
    if (match.index > end) segments.push({ type: 'text', data: { text: decodeCQ(message.slice(end, match.index)) } });
    const data = Object.create(null);
    for (const entry of match[2].slice(1).split(',')) {
      const separator = entry.indexOf('=');
      if (separator > 0) data[entry.slice(0, separator)] = decodeCQ(entry.slice(separator + 1));
    }
    segments.push({ type: match[1].toLowerCase(), data });
    end = match.index + match[0].length;
  }
  if (end < message.length) segments.push({ type: 'text', data: { text: decodeCQ(message.slice(end)) } });
  return segments;
}

/** Parse only event data; the receiver must authenticate the transport separately. */
export function normalizeQQEvent(event, selfQQ = '') {
  if (!event || event.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) return null;
  const uid = qqId(event.user_id ?? event.sender?.user_id);
  const self = qqId(selfQQ);
  const gid = event.message_type === 'group' ? qqId(event.group_id) : '';
  if (!uid || (event.message_type === 'group' && !gid) || uid === self) return null;
  if (event.sub_type === 'self' || String(event.sub_type || '').endsWith('_self')) return null;
  const input = Array.isArray(event.message) ? event.message : cqSegments(
    typeof event.message === 'string' ? event.message : (typeof event.raw_message === 'string' ? event.raw_message : ''),
  );
  const out = {
    key: gid ? `group:${gid}` : `private:${uid}`,
    uid, gid,
    name: String(event.sender?.card || event.sender?.nickname || uid),
    channel: { type: gid ? 'group' : 'private', id: gid || uid },
    messageId: event.message_id == null ? '' : String(event.message_id),
    text: '', mentions: [], replyId: '', images: [], records: [], files: [],
  };
  for (const segment of input) {
    if (!segment || !segment.data || typeof segment.data !== 'object') continue;
    const data = segment.data;
    if (segment.type === 'text') out.text += String(data.text || '');
    else if (segment.type === 'at') {
      const mentioned = String(data.qq || '');
      out.mentions.push(mentioned);
      if (mentioned !== self) out.text += `@${mentioned} `;
    } else if (segment.type === 'reply' && !out.replyId) out.replyId = String(data.id ?? '');
    else if (segment.type === 'image') out.images.push({ ...data });
    else if (segment.type === 'record') out.records.push({ ...data });
    else if (segment.type === 'file') out.files.push({ ...data });
  }
  out.text = out.text.trim();
  return out.text || out.replyId || out.images.length || out.records.length || out.files.length ? out : null;
}

function listed(value, id) {
  const list = String(value || '').split(/[\s,，]+/).filter(Boolean);
  return !list.length || list.includes(id);
}

export function createQQAdmission({ config, now = Date.now }) {
  const wakes = new Map();
  return {
    admit(input, { replyToBot = false, selfQQ = config.selfQQ } = {}) {
      if (!input || !qqId(input.uid) || (input.gid && !qqId(input.gid))) {
        return { allowed: false, reason: 'invalid-input', admin: false, command: '' };
      }
      const admin = String(config.superUsers || '').split(/[\s,，]+/).filter(Boolean).includes(input.uid);
      const command = input.text.match(/^\/\S+/)?.[0] || '';
      const result = (allowed, reason) => ({ allowed, reason, admin, command });
      if (!admin && !listed(config.whitelist, input.uid)) return result(false, 'user-not-allowed');
      if (!input.gid) return result(true, 'private');
      if (!listed(config.groupWhitelist, input.gid)) return result(false, 'group-not-allowed');
      const current = now();
      const timeout = Math.max(5, Number(config.groupWakeTimeoutSec) || 120) * 1000;
      const wake = wakes.get(input.gid);
      const self = qqId(selfQQ);
      const explicit = (Boolean(self) && input.mentions.includes(self)) || (Boolean(input.replyId) && replyToBot === true);
      if (!explicit && (command || !wake || wake.uid !== input.uid || current - wake.at >= timeout || current < wake.at)) {
        if (wake && (current - wake.at >= timeout || current < wake.at)) wakes.delete(input.gid);
        return result(false, command ? 'command-needs-trigger' : 'needs-trigger');
      }
      wakes.set(input.gid, { uid: input.uid, at: current });
      return result(true, explicit ? 'explicit-trigger' : 'continuation');
    },
  };
}
