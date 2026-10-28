import { transcribeQQRecordings } from './qq-recordings.js';

/** Build one native prompt without treating a partial voice transcript as complete. */
export async function prepareQQContent({ input, agent, reply, signal, feedback, nap, config, loadMedia }) {
  const parts = [];
  let voice = '';
  if (input.records.length) {
    const result = await transcribeQQRecordings({ nap, records: input.records,
      enabled: config.asrEnabled === true, apiKey: config.asrDoubaoApiKey, signal });
    if (result.failed) await feedback(input.channel, String(config.asrFailureMessage || '语音识别失败，请发送文字。'));
    else voice = result.text;
  }
  signal.throwIfAborted();
  const text = [input.text, voice].filter(Boolean).join('\n');
  const media = input.images.length || input.files.length
    ? await loadMedia({ input, agent, signal, feedback }) : [];
  if (!text && !media.length && !input.replyId) return [];
  const metadata = input.gid
    ? `QQ群成员：${JSON.stringify(input.name)}（QQ ${input.uid}）`
    : `QQ私聊用户：${JSON.stringify(input.name)}（QQ ${input.uid}）`;
  const message = [metadata, input.messageId ? `QQ消息 ID：${input.messageId}` : '',
    input.replyId ? `被回复的消息（ID ${input.replyId}）：${reply?.text || '[引用内容不可用]'}` : '', text]
    .filter(Boolean).join('\n');
  parts.push({ type: 'text', text: message }, ...media);
  return parts;
}
