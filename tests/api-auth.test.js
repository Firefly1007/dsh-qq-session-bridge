import test from 'node:test';
import assert from 'node:assert/strict';
import { authenticatedHandler } from '../lib/api-auth.js';

test('management routes require the host connection authentication', () => {
  for (const [connection, expected] of [[null, 503], [{ requestRejection: () => 401 }, 401], [{ requestRejection: () => 403 }, 403]]) {
    let called = false;
    const response = { end() {} };
    authenticatedHandler({ get: () => connection }, () => { called = true; })({ headers: {} }, response);
    assert.equal(response.statusCode, expected);
    assert.equal(called, false);
  }
  let called = false;
  const request = { headers: { cookie: 'session' } };
  const connection = { requestRejection(req) { assert.equal(this, connection); assert.equal(req, request); } };
  authenticatedHandler({ get: () => connection }, () => { called = true; })(request, { end() {} });
  assert.equal(called, true);
});
