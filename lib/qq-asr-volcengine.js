import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

const BASE = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/';
const RESOURCE = 'volc.seedasr.auc';

// shortcut: standard Base64 worked in one live test but is undocumented, revisit if the provider changes it.
export async function submitQQSpeech({ apiKey, audio, format, signal, fetcher = fetch }) {
  const key = String(apiKey || '').trim();
  if (!key || !/^[\x21-\x7e]+$/.test(key)) throw new Error('请配置有效的豆包语音 API Key');
  if (!Buffer.isBuffer(audio) || !audio.length || !['wav', 'mp3', 'ogg', 'amr', 'm4a', 'aac', 'spx'].includes(format)) {
    throw new Error('语音数据或格式无效');
  }
  if (audio.length > 512 * 1024 * 1024) throw new Error('语音文件超过豆包识别大小限制');
  const taskId = randomUUID();
  let response;
  try { response = await fetcher(BASE + 'submit', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': RESOURCE,
      'X-Api-Request-Id': taskId, 'X-Api-Sequence': '-1' },
    body: JSON.stringify({ audio: { data: audio.toString('base64'), format }, request: { model_name: 'bigmodel' } }),
  }); } catch { throw Object.assign(new Error('语音识别提交状态未知，请勿自动重发'), { taskId }); }
  const code = response.headers.get('x-api-status-code');
  if (!response.ok || code !== '20000000') {
    throw Object.assign(new Error(`豆包语音识别提交未确认（${code || `HTTP ${response.status}`}），请勿自动重发`), { taskId });
  }
  let body;
  try { body = await response.text(); } catch { throw Object.assign(new Error('语音识别提交结果未确认，请勿自动重发'), { taskId }); }
  if (!body.trim()) return taskId;
  let result;
  try { result = JSON.parse(body); } catch { throw Object.assign(new Error('豆包语音识别提交结果无法解析，请勿自动重发'), { taskId }); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw Object.assign(new Error('豆包语音识别提交结果无效，请勿自动重发'), { taskId });
  }
  if (result.task_id === undefined) return taskId;
  if (typeof result.task_id !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(result.task_id)) {
    throw Object.assign(new Error('豆包语音识别返回了无效任务 ID，请勿自动重发'), { taskId });
  }
  return result.task_id;
}

export async function queryQQSpeech({ apiKey, taskId, signal, fetcher = fetch }) {
  const key = String(apiKey || '').trim();
  if (!key || !/^[\x21-\x7e]+$/.test(key) || typeof taskId !== 'string' || !/^[\x21-\x7e]{1,256}$/.test(taskId)) {
    throw new Error('语音识别凭据或任务 ID 无效');
  }
  const response = await fetcher(BASE + 'query', {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': key, 'X-Api-Resource-Id': RESOURCE,
      'X-Api-Request-Id': taskId },
    body: '{}',
  });
  const code = response.headers.get('x-api-status-code');
  if (!response.ok) throw new Error(`豆包语音识别查询失败（HTTP ${response.status}）`);
  if (['20000001', '20000002'].includes(code)) return { status: 'pending' };
  if (code === '20000003') return { status: 'silent', text: '' };
  if (code !== '20000000') throw new Error(`豆包语音识别失败（${code || '状态未知'}）`);
  const result = await response.json();
  if (typeof result?.result?.text !== 'string') throw new Error('豆包语音识别返回了无效结果');
  return { status: 'complete', text: result.result.text };
}

export async function transcribeQQSpeechSegments({ apiKey, segments, signal, fetcher = fetch }) {
  if (!Array.isArray(segments) || !segments.length || !signal || typeof signal.throwIfAborted !== 'function') {
    throw new Error('需要语音分段和有效的取消信号');
  }
  const texts = [];
  for (const segment of segments) {
    signal.throwIfAborted();
    const taskId = await submitQQSpeech({ apiKey, audio: segment.audio, format: segment.format, signal, fetcher });
    for (;;) {
      signal.throwIfAborted();
      const result = await queryQQSpeech({ apiKey, taskId, signal, fetcher });
      if (result.status === 'pending') { await delay(2000, undefined, { signal }); continue; }
      if (result.status === 'complete' && result.text.trim()) texts.push(result.text.trim());
      break;
    }
  }
  return texts.join('\n');
}
