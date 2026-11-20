import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { createReturnServer } from './index.mjs';

function dispatch(server, path, method = 'GET', body, headers = {}) {
  const request = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  request.method = method;
  request.url = path;
  request.headers = {
    host: '127.0.0.1:4332',
    ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    ...headers,
  };

  return new Promise((resolve, reject) => {
    const response = {
      headersSent: false,
      writeHead(status, responseHeaders) {
        this.status = status;
        this.headers = responseHeaders;
        this.headersSent = true;
      },
      end(value) {
        resolve({ status: this.status, headers: this.headers, body: JSON.parse(value) });
      },
      destroy: reject,
    };
    server.emit('request', request, response);
  });
}

test('assignment HTTP handler requires a request key and returns the latest owner on conflict', async () => {
  const server = createReturnServer();
  server.address = () => ({ port: 4332 });
  try {
    const id = 'RET-2418';
    const before = await dispatch(server, `/api/returns/${id}`);
    const hold = await dispatch(server, `/api/returns/${id}/hold`, 'POST',
      { reviewer: '민서', memo: '실물 확인' },
      { 'if-match': before.headers.ETag, 'idempotency-key': randomUUID() });
    assert.equal(hold.status, 200, JSON.stringify(hold));
    const missingKey = await dispatch(server, `/api/returns/${id}/assign`, 'POST',
      { reviewer: '민서' }, { 'if-match': hold.headers.ETag });
    assert.equal(missingKey.status, 428);

    const key = randomUUID();
    const claim = await dispatch(server, `/api/returns/${id}/assign`, 'POST',
      { reviewer: '민서' }, { 'if-match': hold.headers.ETag, 'idempotency-key': key });
    const stale = await dispatch(server, `/api/returns/${id}/assign`, 'POST',
      { reviewer: '지훈' }, { 'if-match': hold.headers.ETag, 'idempotency-key': randomUUID() });
    assert.equal(claim.status, 200);
    assert.equal(stale.status, 412);
    assert.equal(stale.body.record.assignee, '민서');
    const replay = await dispatch(server, `/api/returns/${id}/assign`, 'POST',
      { reviewer: '민서' }, { 'if-match': hold.headers.ETag, 'idempotency-key': key });
    assert.deepEqual(replay.body, claim.body);
    assert.equal(stale.body.record.events.filter(event => event.label === '재검수 담당').length, 1);

    const unauthorizedRelease = await dispatch(server, `/api/returns/${id}/unassign`, 'POST',
      { reviewer: '지훈' }, { 'if-match': claim.headers.ETag, 'idempotency-key': randomUUID() });
    assert.equal(unauthorizedRelease.status, 409);
    const released = await dispatch(server, `/api/returns/${id}/unassign`, 'POST',
      { reviewer: '민서' }, { 'if-match': claim.headers.ETag, 'idempotency-key': randomUUID() });
    assert.equal(released.status, 200);
    assert.equal(released.body.record.assignee, undefined);
  } finally {
    server.emit('close');
  }
});
