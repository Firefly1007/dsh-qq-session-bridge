function sameId(value, expected) {
  return (typeof value === 'string' || Number.isSafeInteger(value)) && String(value) === expected;
}

/** Verify the reference through a group identity or the requested private history. */
export async function findQQReference(nap, channel, messageId) {
  if (!Number.isSafeInteger(messageId) || !channel || !['group', 'private'].includes(channel.type)
    || typeof channel.id !== 'string' || !/^[1-9]\d*$/.test(channel.id)) return null;
  if (channel.type === 'group') {
    const message = await nap.callAction('get_msg', { message_id: messageId });
    return message && message.message_id === messageId && message.message_type === 'group'
      && sameId(message.group_id, channel.id) ? message : null;
  }
  const history = await nap.callAction('get_friend_msg_history', { user_id: channel.id,
    message_seq: String(messageId), count: 10, reverse_order: false, disable_get_url: true,
    parse_mult_msg: false, quick_reply: true, reverseOrder: false });
  if (!Array.isArray(history?.messages)) return null;
  const matches = history.messages.filter(message => message?.message_id === messageId
    && message.message_type === 'private' && (message.group_id === undefined || message.group_id === 0 || message.group_id === '0'));
  return matches.length === 1 ? matches[0] : null;
}
