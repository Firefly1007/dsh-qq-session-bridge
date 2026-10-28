import fs from 'node:fs';
import files from 'node:fs/promises';
import path from 'node:path';

const IMAGE_HOSTS = new Set(['gchat.qpic.cn', 'multimedia.nt.qq.com.cn']);

function imageType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif';
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

/** Download only fixed NapCat image origins and let the host validate image bytes. */
export async function loadQQImage({ image, limits, signal, fetcher = fetch }) {
  let url;
  try { url = new URL(image?.url); } catch { throw new Error('QQ 图片地址不可用'); }
  if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.username || url.password || url.port) {
    throw new Error('QQ 图片地址不属于受支持的来源');
  }
  if (!Number.isSafeInteger(limits?.maxImageBytes) || limits.maxImageBytes < 1 || !Array.isArray(limits.mediaTypes)) {
    throw new Error('DSH 图片限制不可用');
  }
  const response = await fetcher(url, { signal, redirect: 'error' });
  if (!response.ok || !response.body) throw new Error('QQ 图片下载失败');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > limits.maxImageBytes) throw new Error('QQ 图片超过 DSH 限制');
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  const mediaType = imageType(bytes);
  if (!mediaType || !limits.mediaTypes.includes(mediaType)) throw new Error('QQ 图片格式不受 DSH 支持');
  return { type: 'image', mediaType, data: bytes.toString('base64') };
}
async function uploadQQFile({ file, agent, signal, ctx, nap, qqHome }) {
  const id = file?.file_id;
  if (typeof id !== 'string' || !id || id.length > 512 || /[\\/:\x00-\x1f\x7f]/.test(id)) throw new Error('QQ 文件标识无效');
  const result = await nap.callAction('get_file', { file_id: id });
  signal.throwIfAborted();
  if (process.platform !== 'linux' || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY
    || typeof result?.file !== 'string' || !path.isAbsolute(result.file)) throw new Error('QQ 文件路径不可用');
  const root = await files.realpath(qqHome);
  if (root !== qqHome || (await files.lstat(qqHome)).isSymbolicLink()) throw new Error('QQ 文件目录无效');
  const candidate = path.resolve(result.file);
  const relative = path.relative(root, candidate);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('QQ 文件不在其数据目录中');
  if (typeof file.file === 'string' && result.file_name && result.file_name !== file.file) throw new Error('QQ 文件名称不匹配');
  const expected = Number(file.file_size);
  if (file.file_size !== undefined && (!Number.isSafeInteger(expected) || expected < 0)) throw new Error('QQ 文件大小无效');
  const parts = relative.split(path.sep);
  let directory = await files.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let handle;
  try {
    for (const component of parts.slice(0, -1)) {
      const next = await files.open(`/proc/self/fd/${directory.fd}/${component}`, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      await directory.close(); directory = next;
    }
    const entry = `/proc/self/fd/${directory.fd}/${parts.at(-1)}`;
    handle = await files.open(entry, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(Number.MAX_SAFE_INTEGER)
      || (file.file_size !== undefined && before.size !== BigInt(expected))
      || await files.readlink(`/proc/self/fd/${handle.fd}`) !== candidate) throw new Error('QQ 文件身份或大小无效');
    const receipt = await ctx.fileUploads.uploadStream({ sessionId: agent.id, data: handle.createReadStream({ autoClose: false }),
      signal, name: typeof file.file === 'string' ? file.file : result.file_name });
    const after = await handle.stat({ bigint: true });
    const current = await files.lstat(entry, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n || current.dev !== before.dev || current.ino !== before.ino
      || await files.readlink(`/proc/self/fd/${handle.fd}`) !== candidate || !receipt?.receiptId || !receipt.file?.attachmentId) {
      throw new Error('QQ 文件读取时发生变化');
    }
    return [ { type: 'text', text: `QQ 文件附件：${JSON.stringify(receipt.file.name)}，attachmentId=${receipt.file.attachmentId}。如需读取请调用 qq_read_attachment。` },
      { type: 'file', receiptId: receipt.receiptId } ];
  } finally { if (handle) await handle.close(); await directory.close(); }
}

export function createQQMediaLoader({ ctx, nap, qqHome }) {
  return async ({ input, agent, signal, feedback }) => {
    const parts = [];
    let failed = false;
    const limits = ctx.attachments.imageLimits;
    if (input.images.length && (!Number.isSafeInteger(limits?.maxImagesPerMessage)
      || !Number.isSafeInteger(limits?.maxMessageImageBytes) || input.images.length > limits.maxImagesPerMessage)) {
      failed = true;
    } else {
      let imageBytes = 0;
      for (const image of input.images) {
        try {
          const part = await loadQQImage({ image, limits, signal });
          imageBytes += Buffer.byteLength(part.data, 'base64');
          if (imageBytes > limits.maxMessageImageBytes) throw new Error('QQ 图片总大小超过 DSH 限制');
          parts.push(part);
        } catch (error) { if (signal.aborted) throw error; failed = true; }
      }
    }
    for (const file of input.files) {
      try { parts.push(...await uploadQQFile({ file, agent, signal, ctx, nap, qqHome })); }
      catch (error) { if (signal.aborted) throw error; failed = true; }
    }
    if (failed) await feedback(input.channel, '部分 QQ 附件无法安全读取，请重新发送。');
    return parts;
  };
}
