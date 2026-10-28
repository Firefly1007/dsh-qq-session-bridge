import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureOneBotConfig } from '../lib/napcat-embedded.js';

test('webhook configuration is written and updated independently of the WS server', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-onebot-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const file = path.join(home, 'config', 'onebot11_123.json');
  const config = { napcatHttpPort: 3000, napcatWsPort: 3001, receiveMode: 'ws' };
  assert.equal(ensureOneBotConfig(home, '123', config, 'token'), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).network.httpClients, []);
  config.receiveMode = 'webhook'; config.webhookUrl = 'http://127.0.0.1:3456/napcat-bot/onebot';
  assert.equal(ensureOneBotConfig(home, '123', config, 'token'), true);
  const client = JSON.parse(fs.readFileSync(file)).network.httpClients[0];
  assert.equal(client.url, config.webhookUrl); assert.equal(client.token, 'token');
  assert.equal(ensureOneBotConfig(home, '123', config, 'token'), false);
});
