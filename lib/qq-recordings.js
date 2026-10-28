import { transcribeQQSpeechSegments } from './qq-asr-volcengine.js';

/** Resolve record segments from an authenticated NapCat message, in message order. */
export async function getQQRecordings(nap, records) {
  if (typeof nap?.callAction !== 'function' || !Array.isArray(records) || !records.length) {
    throw new Error('语音消息不可用');
  }
  const segments = [];
  for (const record of records) {
    if (typeof record?.file !== 'string' || !record.file || record.file.length > 512
      || /[\\/:\x00-\x1f\x7f]/.test(record.file) || ['.', '..'].includes(record.file)) {
      throw new Error('语音消息缺少有效文件标识');
    }
    const response = await nap.callAction('get_record', { file: record.file, out_format: 'mp3' });
    const data = response?.base64;
    if (typeof data !== 'string' || !data || data.length > Math.ceil(512 * 1024 * 1024 / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
      throw new Error('NapCat 未返回有效的语音数据');
    }
    const audio = Buffer.from(data, 'base64');
    if (!audio.length || audio.toString('base64') !== data) throw new Error('NapCat 返回的语音数据无效');
    segments.push({ audio, format: 'mp3' });
  }
  return segments;
}
/** Keep partial transcripts out of the conversation when any recording fails. */
export async function transcribeQQRecordings({ nap, records, enabled, apiKey, signal, fetcher }) {
  if (!Array.isArray(records) || !records.length) return { text: '', failed: false };
  if (!enabled || !String(apiKey || '').trim()) return { text: '', failed: true };
  try {
    signal.throwIfAborted();
    const segments = await getQQRecordings(nap, records);
    signal.throwIfAborted();
    const text = await transcribeQQSpeechSegments({ apiKey, segments, signal, ...(fetcher ? { fetcher } : {}) });
    return { text: text ? `[QQ语音转写，可能存在识别误差]\n${text}` : '', failed: false };
  } catch (error) {
    if (signal?.aborted) throw error;
    return { text: '', failed: true };
  }
}
