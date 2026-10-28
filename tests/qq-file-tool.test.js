import { test as nodeTest } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import files from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createQQSendQueue, registerQQTextTool } from '../lib/qq-text-tool.js';
import { registerQQVoiceTool } from '../lib/qq-voice-tool.js';
import { QQ_FILE_TOOL, createQQFileSnapshotStore, registerQQFileTool } from '../lib/qq-file-tool.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
const CONTENT = 'PRIVATE_TEST_FILE_CONTENT';
const test = process.platform === 'linux' ? nodeTest : nodeTest.skip;
const isSourceOpen = file => typeof file === 'string' && /^\/proc\/self\/fd\/\d+\/report\.txt$/.test(file);

function fixture(t, options = {}) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-file-tool-'));
  const workspace = path.join(temporary, 'workspace');
  const outside = path.join(temporary, 'outside');
  fs.mkdirSync(workspace);
  fs.mkdirSync(outside);
  const source = path.join(workspace, 'report.txt');
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(source, CONTENT);
  fs.writeFileSync(secret, 'OUTSIDE_WORKSPACE_SECRET');
  const tools = new Map();
  let current = Object.freeze({});
  const agent = { id: 'qq-file-main', session: { header: { cwd: workspace } }, ctx: { tools: {
    register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name); },
  } } };
  const authorization = { captureSendPermit: () => current, canSend: permit => !!current && permit === current };
  const sendQueue = createQQSendQueue({ agent, authorization });
  const snapshotStore = createQQFileSnapshotStore({ directory: path.join(temporary, 'private-snapshots') });
  const sends = [];
  const channel = options.channel || { type: 'private', id: '123' };
  const nap = { async sendAction(...args) {
    sends.push(args);
    return options.send ? options.send(...args) : { status: 'sent', fileId: null, messageId: sends.length };
  } };
  const dispose = registerQQFileTool({ agent, sendQueue, nap, channel, workspacePath: workspace, snapshotStore });
  const tool = tools.get(QQ_FILE_TOOL);
  const execute = (args = { path: 'report.txt' }, values = {}) => tool.execute(args, {
    agent, signal: new AbortController().signal, ...values,
  });
  t.after(() => {
    dispose();
    sendQueue.stop();
    assert.ok(path.resolve(temporary).startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(temporary, { recursive: true, force: true });
  });
  return { temporary, workspace, outside, source, secret, agent, sendQueue, snapshotStore, sends, channel, nap, tools,
    tool, execute, dispose, end() { current = null; }, next() { current = Object.freeze({}); } };
}

nodeTest('non-Linux hosts refuse file dispatch when secure directory opening is unavailable', { skip: process.platform === 'linux' }, async t => {
  const h = fixture(t);
  assert.equal((await h.execute()).code, 'SECURE_OPEN_UNAVAILABLE');
  assert.equal(h.sends.length, 0);
});

test('sends a stable private snapshot to a fixed target and cleans a confirmed transfer', async t => {
  const h = fixture(t);
  h.channel.id = '999';
  h.nap.sendAction = async (...args) => {
    h.sends.push(args);
    const records = await createQQFileSnapshotStore({ directory: h.snapshotStore.directory }).pending();
    assert.equal(records.length, 1);
    assert.equal(records[0].state, 'pending');
    const snapshot = fileURLToPath(args[1].file);
    assert.equal(fs.readFileSync(snapshot, 'utf8'), CONTENT);
    assert.ok(snapshot.startsWith(h.snapshotStore.directory + path.sep));
    assert.ok(!snapshot.startsWith(h.workspace + path.sep));
    assert.doesNotMatch(JSON.stringify(records), new RegExp(CONTENT));
    return { status: 'sent', fileId: null };
  };
  const output = await h.execute({ path: 'report.txt', name: '报告.txt' });
  assert.equal(output.status, 'sent');
  assert.equal(output.fileId, undefined);
  assert.equal(h.sends[0][0], 'upload_private_file');
  assert.equal(h.sends[0][1].user_id, '123');
  assert.equal(h.sends[0][1].name, '报告.txt');
  assert.equal(h.sends[0][1].upload_file, true);
  assert.equal(h.sends[0][2].timeoutMs, 16000);
  assert.deepEqual(await h.snapshotStore.pending(), []);
  assert.equal(fs.readFileSync(h.source, 'utf8'), CONTENT);
  assert.doesNotMatch(h.tool.output.render({}, output)[0].text, new RegExp(CONTENT));
});

test('group files remain bound to their configured group', async t => {
  const h = fixture(t, { channel: { type: 'group', id: '456' } });
  await h.execute();
  assert.equal(h.sends[0][0], 'upload_group_file');
  assert.equal(h.sends[0][1].group_id, '456');
  assert.equal(h.sends[0][1].user_id, undefined);
});

test('rejects external paths, traversal, URIs, invalid names, destinations and foreign Agents', async t => {
  const h = fixture(t);
  for (const args of [null, {}, [], { path: '' }, { path: '../outside/secret.txt' },
    { path: 'dir/../report.txt' }, { path: 'https://example.invalid/file' }, { path: 'file:///outside/file' },
    { path: 'base64://data' }, { path: 'report.txt', name: '../other' }, { path: 'report.txt', name: 'bad\nname' },
    { path: 'report.txt', target: 'other' }, { path: h.secret }]) {
    assert.equal((await h.execute(args)).status, 'failed');
  }
  assert.equal((await h.execute({ path: 'report.txt' }, { agent: {} })).code, 'WRONG_AGENT');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('rejects directories, empty files, escaping directory links and hard-linked files', async t => {
  const h = fixture(t);
  fs.writeFileSync(path.join(h.workspace, 'empty.txt'), '');
  fs.symlinkSync(h.outside, path.join(h.workspace, 'escape'), 'junction');
  fs.linkSync(h.secret, path.join(h.workspace, 'hard-link.txt'));
  for (const input of ['.', 'empty.txt', 'escape/secret.txt', 'hard-link.txt']) {
    const output = await h.execute({ path: input });
    assert.equal(output.status, 'failed', input);
    assert.doesNotMatch(JSON.stringify(output), /OUTSIDE_WORKSPACE_SECRET/);
  }
  assert.equal(h.sends.length, 0);
});

test('directory aliases are rejected when opening a workspace file', async t => {
  const h = fixture(t);
  const inner = path.join(h.workspace, 'inner');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'inside.txt'), 'inside');
  fs.symlinkSync(inner, path.join(h.workspace, 'alias'), 'junction');
  assert.equal((await h.execute({ path: 'alias/inside.txt' })).status, 'failed');
});

test('a parent replaced by an outside symlink at open is never read', async t => {
  const h = fixture(t);
  const inner = path.join(h.workspace, 'inner');
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(inner, 'secret.txt'), 'inside');
  const originalOpen = files.open.bind(files);
  let swapped = false;
  t.mock.method(files, 'open', async (file, ...args) => {
    if (!swapped && typeof file === 'string' && /^\/proc\/self\/fd\/\d+\/inner$/.test(file)) {
      swapped = true;
      fs.renameSync(inner, path.join(h.workspace, 'original-inner'));
      fs.symlinkSync(h.outside, inner);
    }
    return originalOpen(file, ...args);
  });
  assert.equal((await h.execute({ path: 'inner/secret.txt' })).status, 'failed');
  assert.equal(swapped, true);
  assert.equal(h.sends.length, 0);
});

test('an inode swapped during open cannot make the tool read an outside file', async t => {
  const h = fixture(t);
  const originalOpen = files.open.bind(files);
  const backup = path.join(h.workspace, 'original.txt');
  let swapped = false;
  let outsideReads = 0;
  t.mock.method(files, 'open', async (file, ...args) => {
    if (!isSourceOpen(file) || swapped) return originalOpen(file, ...args);
    swapped = true;
    fs.renameSync(h.source, backup);
    fs.linkSync(h.secret, h.source);
    const handle = await originalOpen(file, ...args);
    fs.unlinkSync(h.source);
    fs.renameSync(backup, h.source);
    const read = handle.read.bind(handle);
    handle.read = async (...values) => { outsideReads += 1; return read(...values); };
    return handle;
  });
  assert.equal((await h.execute()).code, 'FILE_CHANGED');
  assert.equal(outsideReads, 0);
  assert.equal(h.sends.length, 0);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('a source changed while copying is rejected and its incomplete snapshot is cleaned', async t => {
  const h = fixture(t);
  const originalOpen = files.open.bind(files);
  t.mock.method(files, 'open', async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (!isSourceOpen(file)) return handle;
    const read = handle.read.bind(handle);
    let changed = false;
    handle.read = async (...values) => {
      const part = await read(...values);
      if (!changed) {
        changed = true;
        fs.writeFileSync(h.source, 'X'.repeat(CONTENT.length));
        const later = new Date(Date.now() + 10000);
        fs.utimesSync(h.source, later, later);
      }
      return part;
    };
    return handle;
  });
  assert.equal((await h.execute()).code, 'FILE_CHANGED');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('replacing the original path after staging cannot change bytes sent to NapCat', async t => {
  const h = fixture(t);
  const mark = h.snapshotStore.markPending.bind(h.snapshotStore);
  h.snapshotStore.markPending = async id => {
    await mark(id);
    fs.unlinkSync(h.source);
    fs.writeFileSync(h.source, 'replaced source');
  };
  h.nap.sendAction = async (...args) => {
    h.sends.push(args);
    assert.equal(fs.readFileSync(fileURLToPath(args[1].file), 'utf8'), CONTENT);
    return { status: 'sent', fileId: 'file-123' };
  };
  assert.equal((await h.execute()).fileId, 'file-123');
});

test('files above the former 16 MiB assumption use bounded chunks without truncation', async t => {
  const h = fixture(t);
  const size = 20 * 1024 * 1024 + 13;
  fs.truncateSync(h.source, size);
  const reads = [];
  const originalOpen = files.open.bind(files);
  t.mock.method(files, 'open', async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (!isSourceOpen(file)) return handle;
    const read = handle.read.bind(handle);
    handle.read = async (buffer, ...values) => { reads.push(buffer.length); return read(buffer, ...values); };
    return handle;
  });
  h.nap.sendAction = async (...args) => {
    h.sends.push(args);
    assert.equal(fs.statSync(fileURLToPath(args[1].file)).size, size);
    return { status: 'sent', fileId: null };
  };
  assert.equal((await h.execute()).status, 'sent');
  assert.ok(reads.length > 300);
  assert.ok(Math.max(...reads) <= 65536);
  assert.ok(h.sends[0][2].timeoutMs > 15000);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('unknown transfers survive disposal and reopening and require a trusted cleanup proof', async t => {
  const h = fixture(t, { send: async () => ({ status: 'unknown', code: 'SEND_TIMEOUT' }) });
  const output = await h.execute();
  assert.equal(output.status, 'unknown');
  assert.equal(h.sends.length, 1);
  h.dispose();
  const reopened = createQQFileSnapshotStore({ directory: h.snapshotStore.directory });
  const records = await reopened.pending();
  assert.equal(records.length, 1);
  assert.equal(records[0].state, 'unknown');
  assert.equal(fs.readFileSync(records[0].path, 'utf8'), CONTENT);
  assert.equal(await reopened.releaseUnknown(records[0].id), false);
  assert.equal(await reopened.releaseUnknown(records[0].id, true), false);
  assert.equal(await reopened.releaseUnknown(records[0].id, async () => false), false);
  assert.equal(await reopened.releaseUnknown(records[0].id, async () => { throw new Error('cannot prove'); }), false);
  assert.equal(fs.existsSync(records[0].path), true);
  assert.equal(await reopened.releaseUnknown(records[0].id, async record => record.id === records[0].id), true);
  assert.equal(fs.existsSync(records[0].path), false);
});

test('explicit pre-dispatch rejection cleans its private snapshot without retrying', async t => {
  const h = fixture(t, { send: async () => ({ status: 'failed', code: 'ONEBOT_REJECTED' }) });
  assert.equal((await h.execute()).status, 'failed');
  assert.equal(h.sends.length, 1);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('thrown transport errors remain unknown and retain the source required by a late reader', async t => {
  const h = fixture(t, { send: async () => { throw new Error('acknowledgement lost'); } });
  assert.equal((await h.execute()).status, 'unknown');
  const [record] = await h.snapshotStore.pending();
  assert.equal(fs.readFileSync(record.path, 'utf8'), CONTENT);
  assert.equal(h.sends.length, 1);
});

test('cancellation after dispatch keeps an unknown snapshot available for NapCat', async t => {
  const reply = Promise.withResolvers();
  const dispatched = Promise.withResolvers();
  const h = fixture(t, { send: async () => { dispatched.resolve(); return reply.promise; } });
  const controller = new AbortController();
  const pending = h.execute({ path: 'report.txt' }, { signal: controller.signal });
  await dispatched.promise;
  controller.abort();
  h.dispose();
  reply.resolve({ status: 'unknown', code: 'SEND_CANCELLED' });
  assert.equal((await pending).status, 'unknown');
  assert.equal(fs.readFileSync(fileURLToPath(h.sends[0][1].file), 'utf8'), CONTENT);
  assert.equal((await h.snapshotStore.pending())[0].state, 'unknown');
});

test('authorization revoked during preparation or after pending persistence prevents dispatch and cleans safely', async t => {
  for (const phase of ['stage', 'markPending']) {
    await t.test(phase, async child => {
      const h = fixture(child);
      const reached = Promise.withResolvers();
      const release = Promise.withResolvers();
      const operation = h.snapshotStore[phase].bind(h.snapshotStore);
      h.snapshotStore[phase] = async (...args) => {
        if (phase === 'markPending') await operation(...args);
        reached.resolve();
        await release.promise;
        if (phase === 'stage') return operation(...args);
      };
      const pending = h.execute();
      await reached.promise;
      if (phase === 'markPending') assert.equal((await h.snapshotStore.pending())[0].state, 'pending');
      h.next();
      release.resolve();
      assert.equal((await pending).status, 'failed');
      assert.equal(h.sends.length, 0);
      assert.deepEqual(await h.snapshotStore.pending(), []);
    });
  }
});

test('failed pending persistence never dispatches a file', async t => {
  const h = fixture(t);
  h.snapshotStore.markPending = async () => { throw new Error('cannot persist'); };
  assert.equal((await h.execute()).code, 'SNAPSHOT_STATE_FAILED');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('unknown state-write failure retains the already-durable pending record', async t => {
  const h = fixture(t, { send: async () => ({ status: 'unknown' }) });
  const settle = h.snapshotStore.settle.bind(h.snapshotStore);
  h.snapshotStore.settle = async (id, outcome) => {
    if (outcome === 'unknown') throw new Error('cannot update');
    return settle(id, outcome);
  };
  assert.equal((await h.execute()).status, 'unknown');
  assert.equal((await h.snapshotStore.pending())[0].state, 'pending');
});

test('copy failure cleans partial files and a failed cleanup remains discoverable', async t => {
  for (const cleanupFails of [false, true]) {
    await t.test(String(cleanupFails), async child => {
      const h = fixture(child);
      const open = files.open.bind(files);
      child.mock.method(files, 'open', async (file, ...args) => {
        const handle = await open(file, ...args);
        if (path.basename(String(file)) === 'snapshot') handle.write = async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); };
        return handle;
      });
      if (cleanupFails) child.mock.method(files, 'rm', async () => { throw Object.assign(new Error('locked'), { code: 'EACCES' }); });
      assert.equal((await h.execute()).code, 'SNAPSHOT_NO_SPACE');
      assert.equal(h.sends.length, 0);
      const records = await h.snapshotStore.pending();
      assert.equal(records.length, cleanupFails ? 1 : 0);
      if (cleanupFails) {
        assert.equal(records[0].state, 'preparing');
        child.mock.restoreAll();
        assert.equal(await h.snapshotStore.settle(records[0].id, 'not-dispatched'), true);
        assert.deepEqual(await h.snapshotStore.pending(), []);
      }
    });
  }
});

test('snapshot storage exhaustion is reported before copying or dispatching', async t => {
  const h = fixture(t);
  t.mock.method(files, 'statfs', async () => ({ bavail: 0n, bsize: 4096n }));
  assert.equal((await h.execute()).code, 'SNAPSHOT_NO_SPACE');
  assert.equal(h.sends.length, 0);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('file preparation and sends share the existing text and voice queue', { timeout: 2000 }, async t => {
  const first = Promise.withResolvers();
  const fileReply = Promise.withResolvers();
  const fileDispatched = Promise.withResolvers();
  const order = [];
  const h = fixture(t, { send: async (action, params) => {
    if (action.startsWith('upload_')) { order.push('file'); fileDispatched.resolve(); return fileReply.promise; }
    const part = params.message[0];
    order.push(part.type);
    return part.type === 'text' ? first.promise : { status: 'sent', messageId: 2 };
  } });
  registerQQTextTool({ agent: h.agent, sendQueue: h.sendQueue, nap: h.nap, channel: h.channel });
  registerQQVoiceTool({ agent: h.agent, sendQueue: h.sendQueue, nap: h.nap, channel: h.channel,
    config: { ttsDoubaoApiKey: 'test-only-unused', ttsVoice: 'fixed' }, synthesize: async () => { order.push('synthesis'); return 'YXVkaW8='; } });
  const execution = { agent: h.agent, signal: new AbortController().signal };
  const text = h.tools.get('qq_send_text').execute({ text: 'first' }, execution);
  const file = h.execute();
  const voice = h.tools.get('qq_send_voice').execute({ text: 'last' }, execution);
  await tick();
  assert.deepEqual(order, ['text']);
  assert.deepEqual(await h.snapshotStore.pending(), []);
  first.resolve({ status: 'sent', messageId: 1 });
  await fileDispatched.promise;
  assert.deepEqual(order, ['text', 'file']);
  fileReply.resolve({ status: 'sent', fileId: null });
  await Promise.all([text, file, voice]);
  assert.deepEqual(order, ['text', 'file', 'synthesis', 'record']);
  assert.deepEqual(await h.snapshotStore.pending(), []);
});

test('workspaces and snapshot directories must have independent confirmed ownership', async t => {
  const h = fixture(t);
  const otherAgent = { ...h.agent, session: { header: { cwd: h.outside } } };
  assert.throws(() => registerQQFileTool({ agent: otherAgent, sendQueue: h.sendQueue, nap: h.nap,
    channel: h.channel, workspacePath: h.workspace, snapshotStore: h.snapshotStore }), /fixed QQ workspace/);
  const arbitrary = path.join(h.temporary, 'unowned');
  fs.mkdirSync(arbitrary, { mode: 0o700 });
  fs.writeFileSync(path.join(arbitrary, 'existing-user-file'), 'preserve');
  assert.throws(() => createQQFileSnapshotStore({ directory: arbitrary }), /dedicated/);
  assert.equal(fs.readFileSync(path.join(arbitrary, 'existing-user-file'), 'utf8'), 'preserve');
});
