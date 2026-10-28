export const QQ_READ_ATTACHMENT = 'qq_read_attachment';
const MAX_CHUNK = 65536;

/** Read only a file admitted from the current authenticated QQ turn. */
export function registerQQReadAttachment({ agent, authorization, attachments }) {
  if (typeof agent?.ctx?.tools?.register !== 'function' || typeof authorization?.captureSendPermit !== 'function'
    || typeof authorization?.resolveQQFile !== 'function' || typeof attachments?.readFileStream !== 'function') {
    throw new TypeError('QQ attachment reader dependencies are unavailable');
  }
  let disposed = false;
  const unregister = agent.ctx.tools.register({
    name: QQ_READ_ATTACHMENT,
    description: '读取本轮 QQ 消息中的文件附件，按 attachmentId 分段读取；仅能读取当前 QQ 来源已核实的附件。offset 与 length 为字节，单次最多 65536 字节。',
    parameters: { type: 'object', additionalProperties: false, properties: {
      attachmentId: { type: 'string', minLength: 1 }, offset: { type: 'integer', minimum: 0 },
      length: { type: 'integer', minimum: 1, maximum: MAX_CHUNK },
    }, required: ['attachmentId'] },
    output: { schema: { type: 'object', additionalProperties: false, properties: {
      status: { type: 'string', enum: ['ok', 'failed'] }, message: { type: 'string' },
      data: { type: 'string' }, encoding: { type: 'string', enum: ['utf8', 'base64'] },
      offset: { type: 'integer' }, nextOffset: { type: 'integer' }, size: { type: 'integer' }, eof: { type: 'boolean' },
    }, required: ['status', 'message'] }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(args, execution) {
      const fail = message => ({ status: 'failed', message });
      if (execution?.agent !== agent || disposed || !args || typeof args !== 'object' || Array.isArray(args)
        || Object.keys(args).some(key => !['attachmentId', 'offset', 'length'].includes(key))
        || typeof args.attachmentId !== 'string' || !args.attachmentId) return fail('附件请求无效。');
      const offset = args.offset ?? 0, length = args.length ?? MAX_CHUNK;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > MAX_CHUNK) {
        return fail('附件读取范围无效。');
      }
      const permit = authorization.captureSendPermit();
      const ref = authorization.resolveQQFile(args.attachmentId, permit);
      if (!ref || offset > ref.bytes) return fail('当前 QQ 轮次没有此附件或读取范围无效。');
      const allowed = () => !disposed && !execution.signal?.aborted
        && authorization.resolveQQFile(args.attachmentId, permit) !== null;
      const pieces = [];
      let position = 0, selected = 0;
      try {
        for await (const part of attachments.readFileStream(ref, execution.signal)) {
          if (!allowed()) return fail('QQ 附件读取授权已结束。');
          const bytes = Buffer.from(part);
          const start = Math.max(0, offset - position), end = Math.min(bytes.length, offset + length - position);
          if (end > start) { const slice = bytes.subarray(start, end); pieces.push(slice); selected += slice.length; }
          position += bytes.length;
          if (position > ref.bytes) throw new Error('Attachment size changed');
        }
        if (!allowed() || position !== ref.bytes) return fail('附件读取未能完整验证。');
        const data = Buffer.concat(pieces, selected);
        let encoding = 'utf8', value;
        try { value = new TextDecoder('utf-8', { fatal: true }).decode(data); if (value.includes('\0')) throw new Error(); }
        catch { encoding = 'base64'; value = data.toString('base64'); }
        return { status: 'ok', message: 'QQ 附件读取成功。', encoding, data: value, offset,
          nextOffset: offset + selected, size: ref.bytes, eof: offset + selected === ref.bytes };
      } catch { return fail('QQ 附件读取或完整性校验失败。'); }
    },
  });
  return () => { disposed = true; unregister(); };
}
