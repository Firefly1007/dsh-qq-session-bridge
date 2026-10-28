import fs from 'node:fs';
import files from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const QQ_FILE_TOOL = 'qq_send_file';
const CHUNK = 65536;
const LEASE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function failure(code, message) { return Object.assign(new Error(message), { qqFileCode: code }); }
function sameNode(left, right) { return left.dev === right.dev && left.ino === right.ino && left.ino > 0n; }
function within(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
async function syncDirectory(directory) {
  // The Linux target supports directory fsync; Windows checks logical lifecycle only.
  if (process.platform === 'win32') return;
  const handle = await files.open(directory, fs.constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Private durable storage. Unknown leases have no TTL and require an explicit trusted cleanup proof. */
export function createQQFileSnapshotStore({ directory }) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new TypeError('A private absolute snapshot directory is required');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new TypeError('Snapshot directory must not be a symbolic link');
  const root = fs.realpathSync(directory);
  const identity = fs.lstatSync(root, { bigint: true });
  if (!identity.isDirectory() || identity.ino <= 0n
    || (process.platform !== 'win32' && (identity.mode & 0o077n) !== 0n)) throw new TypeError('Snapshot directory must be private');
  const marker = path.join(root, '.qq-file-snapshots');
  const ownership = 'dsh-qq-session-bridge/qq-file-snapshots/v1';
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(root).length) throw new TypeError('Snapshot directory must be dedicated to this store');
    fs.writeFileSync(marker, ownership, { flag: 'wx', mode: 0o600 });
  } else {
    const info = fs.lstatSync(marker);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128 || fs.readFileSync(marker, 'utf8') !== ownership) {
      throw new TypeError('Snapshot directory ownership cannot be confirmed');
    }
  }

  async function verifyRoot() {
    if (await files.realpath(directory) !== root || !sameNode(identity, await files.lstat(root, { bigint: true }))) {
      throw failure('SNAPSHOT_STORE_CHANGED', '私有文件快照目录身份已变化。');
    }
  }
  function leasePath(id) {
    if (typeof id !== 'string' || !LEASE_ID.test(id)) throw new TypeError('Invalid snapshot identity');
    return path.join(root, id);
  }
  async function writeState(record) {
    await verifyRoot();
    const folder = leasePath(record.id);
    const temporary = path.join(folder, `.state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await files.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      await handle.close();
      handle = null;
      await files.rename(temporary, path.join(folder, 'state.json'));
      await syncDirectory(folder);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await files.unlink(temporary).catch(() => {});
    }
  }
  async function readState(id) {
    await verifyRoot();
    const folder = leasePath(id);
    const folderInfo = await files.lstat(folder);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) throw new Error('Invalid snapshot directory');
    const handle = await files.open(path.join(folder, 'state.json'), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error('Invalid snapshot state');
      const bytes = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < bytes.length) {
        const part = await handle.read(bytes, offset, bytes.length - offset, offset);
        if (!part.bytesRead) throw new Error('Incomplete snapshot state');
        offset += part.bytesRead;
      }
      const record = JSON.parse(bytes.toString('utf8'));
      if (record.version !== 1 || record.id !== id || !['preparing', 'prepared', 'pending', 'unknown', 'sent', 'not-dispatched'].includes(record.state)
        || !Number.isSafeInteger(record.bytes) || record.bytes < 0 || !Number.isSafeInteger(record.createdAt)) throw new Error('Invalid snapshot state');
      return record;
    } finally { await handle.close(); }
  }
  async function remove(id) {
    await verifyRoot();
    const target = leasePath(id);
    if (path.dirname(target) !== root) throw new Error('Snapshot cleanup escaped its owner');
    await files.rm(target, { recursive: true, force: true });
    await syncDirectory(root);
  }
  async function settle(id, outcome) {
    if (!['sent', 'not-dispatched', 'unknown'].includes(outcome)) throw new TypeError('Invalid snapshot outcome');
    if (outcome === 'unknown') {
      const record = await readState(id);
      await writeState({ ...record, state: 'unknown' });
      return false;
    }
    try { await writeState({ ...await readState(id), state: outcome }); } catch { /* A proven safe outcome may still be cleaned. */ }
    try { await remove(id); return true; } catch { return false; }
  }

  return {
    directory: root,
    async stage(copyToHandle, expectedBytes) {
      if (typeof copyToHandle !== 'function' || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) throw new TypeError('A bounded copy and file size are required');
      await verifyRoot();
      try {
        const capacity = await files.statfs(root, { bigint: true });
        if (capacity.bavail * capacity.bsize < BigInt(expectedBytes)) throw failure('SNAPSHOT_NO_SPACE', '可用存储空间不足，文件未发送。');
      } catch (error) { if (!['ENOSYS', 'ENOTSUP'].includes(error.code)) throw error; }
      const id = randomUUID();
      const folder = leasePath(id);
      await files.mkdir(folder, { mode: 0o700 });
      let handle;
      try {
        await syncDirectory(root);
        const record = { version: 1, id, state: 'preparing', bytes: expectedBytes, createdAt: Date.now() };
        await writeState(record);
        handle = await files.open(path.join(folder, 'snapshot'), 'wx', 0o600);
        const written = await copyToHandle(handle);
        if (written !== expectedBytes || (await handle.stat()).size !== expectedBytes) throw failure('FILE_CHANGED', '文件快照不完整，未发送。');
        await handle.sync();
        if (process.platform !== 'win32') await handle.chmod(0o400);
        await handle.close();
        handle = null;
        await writeState({ ...record, state: 'prepared' });
        return Object.freeze({ id, path: path.join(folder, 'snapshot'), bytes: written });
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        await remove(id).catch(() => {});
        throw error;
      }
    },
    async markPending(id) {
      const record = await readState(id);
      if (record.state !== 'prepared') throw new Error('Snapshot was already dispatched or cannot be confirmed');
      await writeState({ ...record, state: 'pending' });
    },
    settle,
    async pending() {
      await verifyRoot();
      const records = [];
      for (const name of await files.readdir(root)) {
        if (!LEASE_ID.test(name)) continue;
        let record;
        try { record = await readState(name); }
        catch { record = { id: name, state: 'unreadable', bytes: null, createdAt: null }; }
        records.push({ ...record, path: path.join(leasePath(name), 'snapshot') });
      }
      return records;
    },
    async releaseUnknown(id, verifyNoReaders) {
      if (typeof verifyNoReaders !== 'function') return false;
      const records = await this.pending();
      const record = records.find(item => item.id === id);
      if (!record) return true;
      let safe;
      try { safe = await verifyNoReaders(Object.freeze(record)); } catch { return false; }
      if (safe !== true) return false;
      try { await remove(id); return true; } catch { return false; }
    },
  };
}

function result(status, code, message, fileId) {
  return { status, ...(code ? { code } : {}), message,
    ...(typeof fileId === 'string' ? { fileId } : {}) };
}

export function registerQQFileTool({ agent, sendQueue, nap, channel, workspacePath, snapshotStore }) {
  if (!agent?.ctx?.tools || typeof agent.ctx.tools.register !== 'function' || typeof sendQueue?.enqueue !== 'function'
    || typeof nap?.sendAction !== 'function' || !snapshotStore || !['stage', 'markPending', 'settle'].every(key => typeof snapshotStore[key] === 'function')) {
    throw new TypeError('QQ file tool dependencies are unavailable');
  }
  if (!channel || !['private', 'group'].includes(channel.type) || typeof channel.id !== 'string' || !/^[1-9]\d*$/.test(channel.id)) throw new TypeError('A fixed QQ channel is required');
  let root;
  let rootNode;
  try {
    if (typeof workspacePath !== 'string' || !path.isAbsolute(workspacePath) || typeof agent.session?.header?.cwd !== 'string'
      || !path.isAbsolute(agent.session.header.cwd) || fs.lstatSync(workspacePath).isSymbolicLink()) throw new Error();
    root = fs.realpathSync(workspacePath);
    rootNode = fs.lstatSync(root, { bigint: true });
    if (!rootNode.isDirectory() || rootNode.ino <= 0n || fs.realpathSync(agent.session.header.cwd) !== root
      || snapshotStore.directory === root || within(root, snapshotStore.directory) || within(snapshotStore.directory, root)) throw new Error();
  } catch { throw new TypeError('A fixed QQ workspace and separate private snapshot store are required'); }
  const target = { type: channel.type, id: channel.id };
  const active = new Set();
  let disposed = false;

  async function verifyRoot() {
    if ((await files.lstat(workspacePath)).isSymbolicLink() || await files.realpath(workspacePath) !== root
      || await files.realpath(agent.session.header.cwd) !== root || !sameNode(rootNode, await files.lstat(root, { bigint: true }))) {
      throw failure('WORKSPACE_CHANGED', 'QQ 工作区身份已变化，文件未发送。');
    }
  }
  async function prepare(input, available) {
    await verifyRoot();
    const candidate = path.resolve(root, input);
    if (!within(root, candidate)) throw failure('OUTSIDE_WORKSPACE', '只能发送当前 QQ 工作区内的文件。');
    if (!available()) throw failure('NOT_AUTHORIZED', '文件发送许可或步骤已结束，未发送。');
    if (process.platform !== 'linux' || !fs.constants.O_NOFOLLOW || !fs.constants.O_DIRECTORY) {
      throw failure('SECURE_OPEN_UNAVAILABLE', '当前平台无法安全解析工作区路径，文件未发送。');
    }
    const parts = path.relative(root, candidate).split(path.sep);
    let directory = await files.open(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    let handle;
    try {
      if (!sameNode(rootNode, await directory.stat({ bigint: true }))) throw failure('WORKSPACE_CHANGED', 'QQ 工作区身份已变化，文件未发送。');
      for (const component of parts.slice(0, -1)) {
        const next = await files.open(`/proc/self/fd/${directory.fd}/${component}`,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
        const previous = directory;
        directory = next;
        await previous.close();
      }
      const entryPath = `/proc/self/fd/${directory.fd}/${parts.at(-1)}`;
      handle = await files.open(entryPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      const before = await handle.stat({ bigint: true });
      if (!before.isFile()) throw failure('NOT_REGULAR_FILE', '只能发送普通文件。');
      if (before.nlink !== 1n) throw failure('LINKED_FILE', '不发送多重硬链接文件。');
      if (before.size === 0n) throw failure('EMPTY_FILE', 'NapCat 不支持发送空文件。');
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw failure('FILE_ADDRESS_UNSUPPORTED', '文件超出当前文件系统接口的精确寻址能力。');
      const verifyPath = async () => {
        await verifyRoot();
        const entry = await files.lstat(entryPath, { bigint: true });
        if (entry.isSymbolicLink() || !sameNode(before, entry)
          || await files.readlink(`/proc/self/fd/${handle.fd}`) !== candidate) {
          throw failure('FILE_CHANGED', '文件路径在准备期间被替换，未发送。');
        }
      };
      await verifyPath();
      return await snapshotStore.stage(async destination => {
        const bytes = Buffer.alloc(CHUNK);
        const size = Number(before.size);
        let offset = 0;
        while (offset < size) {
          if (!available()) throw failure('NOT_AUTHORIZED', '文件发送许可或步骤已结束，未发送。');
          const read = await handle.read(bytes, 0, Math.min(bytes.length, size - offset), offset);
          if (!read.bytesRead) throw failure('FILE_CHANGED', '文件在读取期间变化，未发送。');
          let written = 0;
          while (written < read.bytesRead) {
            if (!available()) throw failure('NOT_AUTHORIZED', '文件发送许可或步骤已结束，未发送。');
            const part = await destination.write(bytes, written, read.bytesRead - written, offset + written);
            if (!part.bytesWritten) throw failure('SNAPSHOT_WRITE_FAILED', '无法写入私有文件快照。');
            written += part.bytesWritten;
          }
          offset += read.bytesRead;
        }
        const tail = await handle.read(bytes, 0, 1, size);
        const after = await handle.stat({ bigint: true });
        if (tail.bytesRead || !sameNode(before, after) || before.size !== after.size || before.mtimeNs !== after.mtimeNs
          || before.ctimeNs !== after.ctimeNs || after.nlink !== 1n) throw failure('FILE_CHANGED', '文件在读取期间变化，未发送。');
        await verifyPath();
        return offset;
      }, Number(before.size));
    } finally { if (handle) await handle.close(); await directory.close(); }
  }

  const unregister = agent.ctx.tools.register({
    name: QQ_FILE_TOOL,
    description: '发送当前 QQ 工作区内的普通文件到当前会话。仅提供 path 和可选 name；不接受外链、工作区外文件或目标。没有固定大小上限，但受存储与平台能力限制。状态未知时不会重发。',
    parameters: { type: 'object', additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1 }, name: { type: 'string', minLength: 1 } }, required: ['path'] },
    output: {
      schema: { type: 'object', additionalProperties: false,
        properties: { status: { type: 'string', enum: ['sent', 'failed', 'unknown'] }, code: { type: 'string' },
          message: { type: 'string' }, fileId: { type: 'string' } }, required: ['status', 'message'] },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args, execution) {
      if (execution?.agent !== agent) return Promise.resolve(result('failed', 'WRONG_AGENT', '只有绑定的 QQ 主 Agent 可以发送文件。'));
      if (!args || typeof args !== 'object' || Array.isArray(args) || !Object.hasOwn(args, 'path')
        || Object.keys(args).some(key => !['path', 'name'].includes(key)) || typeof args.path !== 'string' || !args.path.trim()
        || args.path.includes('\0') || args.path.split(/[\\/]/).includes('..')
        || (/^[a-z][a-z0-9+.-]*:/i.test(args.path) && !path.isAbsolute(args.path))
        || (args.name !== undefined && (typeof args.name !== 'string' || !args.name.trim() || /[\\/\x00-\x1f\x7f]/.test(args.name) || ['.', '..'].includes(args.name)))) {
        return Promise.resolve(result('failed', 'INVALID_FILE', '仅接受工作区文件 path 和可选文件名 name，不接受外链、路径穿越或目标。'));
      }
      const input = args.path;
      const name = args.name || path.basename(input);
      return sendQueue.enqueue(execution, async canDispatch => {
        const controller = new AbortController();
        const signal = execution.signal ? AbortSignal.any([execution.signal, controller.signal]) : controller.signal;
        const available = () => !disposed && !signal.aborted && canDispatch();
        active.add(controller);
        let snapshot;
        try {
          if (!available()) return result('failed', 'SEND_CANCELLED', '文件发送已在派发前取消。');
          try { snapshot = await prepare(input, available); }
          catch (error) { return result('failed', error.qqFileCode || (error.code === 'ENOSPC' ? 'SNAPSHOT_NO_SPACE' : 'FILE_UNAVAILABLE'),
            error.qqFileCode ? error.message : error.code === 'ENOSPC' ? '存储空间不足，文件未发送。' : '无法安全准备当前 QQ 工作区内的文件，未发送。'); }
          try {
            if (!available()) { await snapshotStore.settle(snapshot.id, 'not-dispatched'); return result('failed', 'NOT_AUTHORIZED', '文件发送许可或步骤已结束，未发送。'); }
            await snapshotStore.markPending(snapshot.id);
          } catch {
            await snapshotStore.settle(snapshot.id, 'not-dispatched').catch(() => {});
            return result('failed', 'SNAPSHOT_STATE_FAILED', '无法持久记录文件派发状态，未发送。');
          }
          if (!available()) {
            await snapshotStore.settle(snapshot.id, 'not-dispatched').catch(() => {});
            return result('failed', 'NOT_AUTHORIZED', '文件发送许可或步骤已结束，未发送。');
          }
          let response;
          try {
            response = await nap.sendAction(target.type === 'group' ? 'upload_group_file' : 'upload_private_file', {
              [target.type === 'group' ? 'group_id' : 'user_id']: target.id,
              file: pathToFileURL(snapshot.path).href, name, upload_file: true,
            }, { signal, timeoutMs: Math.min(1805000, 15000 + Math.ceil(snapshot.bytes / (256 * 1024)) * 1000) });
          } catch { response = { status: 'unknown' }; }
          const outcome = response?.status === 'sent' ? 'sent' : response?.status === 'failed' ? 'not-dispatched' : 'unknown';
          await snapshotStore.settle(snapshot.id, outcome).catch(() => {});
          if (response?.status === 'sent') return result('sent', undefined, 'QQ 文件已发送。', response.fileId);
          if (response?.status === 'failed') return result('failed', 'FILE_SEND_FAILED', 'QQ 文件发送被明确拒绝。');
          return result('unknown', 'FILE_SEND_UNKNOWN', 'QQ 文件发送状态未知，可能已送达；未自动重发。');
        } finally { active.delete(controller); }
      });
    },
  });
  return () => {
    if (disposed) return;
    disposed = true;
    for (const controller of active) controller.abort();
    unregister();
  };
}
