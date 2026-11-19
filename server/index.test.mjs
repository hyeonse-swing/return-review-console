import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createReturnServer } from './index.mjs';

async function withServer(qa, run, databasePath) {
  const server = createReturnServer({ qa, databasePath });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(url);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
}

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'return-console-test-'));
  try {
    await run(join(directory, 'console.sqlite'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function rawRequest(url, path, method, headers, body) {
  const address = new URL(url);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: address.hostname, port: address.port, path, method, headers,
    }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end(body);
  });
}

async function getRecord(url, id = 'RET-2418') {
  const response = await fetch(`${url}/api/returns/${id}`);
  assert.equal(response.status, 200);
  return { etag: response.headers.get('etag'), record: (await response.json()).record };
}

function approve(url, id, etag, reviewer, memo, key) {
  return fetch(`${url}/api/returns/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag, ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ reviewer, memo }),
  });
}

async function setFault(url, on) {
  return fetch(`${url}/__qa/fault`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ on }),
  });
}

test('only one concurrent approval is committed, and stale editors receive the latest record', async () => {
  await withServer(false, async url => {
    const initial = await getRecord(url);
    assert.equal(initial.etag, '"1"');
    assert.equal(initial.record.status, 'pending');

    const responses = await Promise.all([
      approve(url, 'RET-2418', initial.etag, '검수 담당 A', '택과 상품 상태 확인'),
      approve(url, 'RET-2418', initial.etag, '검수 담당 B', '오염 여부 확인'),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);

    const stale = responses.find(response => response.status === 412);
    assert.equal(stale.headers.get('etag'), '"2"');
    const staleBody = await stale.json();
    assert.equal(staleBody.code, 'STALE_VERSION');
    assert.equal(staleBody.record.status, 'approved');

    const latest = await getRecord(url);
    assert.equal(latest.etag, '"2"');
    assert.equal(latest.record.version, 2);
    assert.equal(latest.record.events.filter(event => event.label === '검수 승인').length, 1);
    assert.equal(latest.record.events.at(-1).memo, (await responses.find(response => response.status === 200).json()).record.events.at(-1).memo);

    const alreadyApproved = await approve(url, 'RET-2418', latest.etag, '검수 담당 C', '추가 승인 시도');
    assert.equal(alreadyApproved.status, 409);
    assert.equal((await alreadyApproved.json()).code, 'ALREADY_APPROVED');
  });
});

test('503 fault leaves version and history unchanged, then the same request can be retried', async () => {
  await withServer(true, async url => {
    const initial = await getRecord(url, 'RET-2421');
    assert.equal((await setFault(url, true)).status, 200);

    const unavailable = await approve(url, 'RET-2421', initial.etag, '검수 담당 A', '상태 확인 완료');
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).code, 'APPROVAL_UNAVAILABLE');
    const afterFault = await getRecord(url, 'RET-2421');
    assert.deepEqual(afterFault, initial);

    assert.equal((await setFault(url, false)).status, 200);
    const recovered = await approve(url, 'RET-2421', initial.etag, '검수 담당 A', '상태 확인 완료');
    assert.equal(recovered.status, 200);
    assert.equal(recovered.headers.get('etag'), '"2"');
    const afterRetry = await getRecord(url, 'RET-2421');
    assert.equal(afterRetry.record.status, 'approved');
    assert.equal(afterRetry.record.events.filter(event => event.label === '검수 승인').length, 1);
  });
});

test('a lost success response can be replayed with the same request ID, even during a later fault', async () => {
  await withServer(true, async url => {
    const initial = await getRecord(url);
    const key = randomUUID();
    const first = await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key);
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.record.events.at(-1).actor, '민서');

    const replay = await approve(url, 'RET-2418', initial.etag, ' 민서 ', ' 상태 확인 ', key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('etag'), '"2"');
    assert.deepEqual(await replay.json(), firstBody);

    assert.equal((await setFault(url, true)).status, 200);
    const duringFault = await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key);
    assert.equal(duringFault.status, 200);
    assert.deepEqual(await duringFault.json(), firstBody);

    const latest = await getRecord(url);
    assert.equal(latest.record.events.filter(event => event.label === '검수 승인').length, 1);
    assert.equal(latest.record.version, 2);
  });
});

test('a request ID cannot approve different input or a different record', async () => {
  await withServer(false, async url => {
    const initial = await getRecord(url);
    const key = randomUUID();
    assert.equal((await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key)).status, 200);
    for (const [id, etag, reviewer, memo] of [
      ['RET-2418', initial.etag, '지훈', '상태 확인'],
      ['RET-2418', initial.etag, '민서', '다른 메모'],
      ['RET-2418', '"2"', '민서', '상태 확인'],
      ['RET-2421', initial.etag, '민서', '상태 확인'],
    ]) {
      const response = await approve(url, id, etag, reviewer, memo, key);
      assert.equal(response.status, 409);
      assert.equal((await response.json()).code, 'IDEMPOTENCY_KEY_REUSED');
    }
    assert.equal((await getRecord(url, 'RET-2421')).record.status, 'pending');
    assert.equal((await getRecord(url)).record.events.filter(event => event.label === '검수 승인').length, 1);
  });
});

test('an uncommitted request ID can retry, while a new ID or legacy request keeps stale-version behavior', async () => {
  await withServer(true, async url => {
    const initial = await getRecord(url);
    const key = randomUUID();
    assert.equal((await setFault(url, true)).status, 200);
    const outage = await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key);
    assert.equal(outage.status, 503);
    assert.deepEqual(await getRecord(url), initial);
    assert.equal((await setFault(url, false)).status, 200);
    assert.equal((await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key)).status, 200);
    const changedKey = await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', randomUUID());
    assert.equal(changedKey.status, 412);
    assert.equal((await changedKey.json()).record.events.at(-1).actor, '민서');
    const legacy = await approve(url, 'RET-2418', initial.etag, '지훈', '다른 검수');
    assert.equal(legacy.status, 412);
    const invalidKey = await approve(url, 'RET-2421', '"1"', '민서', '', 'same-key');
    assert.equal(invalidKey.status, 400);
    assert.equal((await invalidKey.json()).code, 'INVALID_IDEMPOTENCY_KEY');
  });
});

test('QA controls stay hidden by default and collector retains original JSON only in bounded memory', async () => {
  await withServer(false, async url => {
    assert.equal((await fetch(`${url}/__qa/events`)).status, 404);
    assert.equal((await setFault(url, true)).status, 404);
    assert.equal((await getRecord(url)).record.status, 'pending');
  });

  await withServer(true, async url => {
    const batch = { schemaVersion: 1, events: [{ eventId: 'synthetic-event-1', message: 'synthetic failure' }] };
    const delivered = await fetch(`${url}/api/client-errors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(batch),
    });
    assert.equal(delivered.status, 204);
    const stored = await fetch(`${url}/__qa/events`);
    assert.equal(stored.status, 200);
    assert.deepEqual(await stored.json(), { batches: [batch] });
  });
});

test('approval requires an exact version and valid review text', async () => {
  await withServer(false, async url => {
    const initial = await getRecord(url);
    const missing = await fetch(`${url}/api/returns/RET-2418/approve`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer: '검수 담당', memo: '확인' }),
    });
    assert.equal(missing.status, 428);
    const invalid = await approve(url, 'RET-2418', initial.etag, '검수 담당', 42);
    assert.equal(invalid.status, 400);
    const tooLong = await approve(url, 'RET-2418', initial.etag, '검수 담당', '가'.repeat(501));
    assert.equal(tooLong.status, 400);
    assert.deepEqual(await getRecord(url), initial);
  });
});

test('approval accepts omitted or blank memo and records no empty memo', async () => {
  await withServer(false, async url => {
    const blankInitial = await getRecord(url);
    const blank = await approve(url, 'RET-2418', blankInitial.etag, '검수 담당 A', '   ');
    assert.equal(blank.status, 200);
    assert.equal(Object.hasOwn((await blank.json()).record.events.at(-1), 'memo'), false);

    const omittedInitial = await getRecord(url, 'RET-2421');
    const omitted = await fetch(`${url}/api/returns/RET-2421/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': omittedInitial.etag },
      body: JSON.stringify({ reviewer: '검수 담당 B' }),
    });
    assert.equal(omitted.status, 200);
    assert.equal(Object.hasOwn((await omitted.json()).record.events.at(-1), 'memo'), false);
  });
});

test('approval and receipt survive a database reopen without resetting seeded records', async () => {
  await withDatabase(async databasePath => {
    const key = randomUUID();
    let approved;
    await withServer(true, async url => {
      const initial = await getRecord(url);
      const response = await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key);
      assert.equal(response.status, 200);
      approved = await response.json();
      const batch = await fetch(`${url}/api/client-errors`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events: [{ message: 'ephemeral QA event' }] }),
      });
      assert.equal(batch.status, 204);
    }, databasePath);

    await withServer(true, async url => {
      const latest = await getRecord(url);
      assert.deepEqual(latest.record, approved.record);
      assert.equal(latest.etag, '"2"');
      assert.deepEqual(await (await fetch(`${url}/__qa/events`)).json(), { batches: [] });
      assert.equal((await setFault(url, true)).status, 200);

      const replay = await approve(url, 'RET-2418', '"1"', ' 민서 ', ' 상태 확인 ', key);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), approved);
      const conflict = await approve(url, 'RET-2418', '"1"', '지훈', '상태 확인', key);
      assert.equal(conflict.status, 409);
      assert.equal((await conflict.json()).code, 'IDEMPOTENCY_KEY_REUSED');
      const seeded = await getRecord(url, 'RET-2421');
      assert.equal(seeded.record.status, 'pending');
    }, databasePath);
  });
});

test('two server connections to one database serialize approvals and share receipts', async () => {
  await withDatabase(async databasePath => {
    await withServer(false, async firstUrl => {
      await withServer(false, async secondUrl => {
        const initial = await getRecord(firstUrl, 'RET-2423');
        assert.deepEqual(await getRecord(secondUrl, 'RET-2423'), initial);
        const firstKey = randomUUID();
        const secondKey = randomUUID();
        const responses = await Promise.all([
          approve(firstUrl, 'RET-2423', initial.etag, '민서', '첫 검수', firstKey),
          approve(secondUrl, 'RET-2423', initial.etag, '지훈', '두 번째 검수', secondKey),
        ]);
        assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);
        const winner = responses.findIndex(response => response.status === 200);
        const approved = await responses[winner].json();
        const oppositeUrl = winner === 0 ? secondUrl : firstUrl;
        const replayKey = winner === 0 ? firstKey : secondKey;
        const replay = await approve(oppositeUrl, 'RET-2423', initial.etag,
          approved.record.events.at(-1).actor, approved.record.events.at(-1).memo, replayKey);
        assert.equal(replay.status, 200);
        assert.deepEqual(await replay.json(), approved);
        for (const url of [firstUrl, secondUrl]) {
          const latest = await getRecord(url, 'RET-2423');
          assert.deepEqual(latest.record, approved.record);
          assert.equal(latest.record.events.filter(event => event.label === '검수 승인').length, 1);
        }
      }, databasePath);
    }, databasePath);
  });
});

test('invalid storage fails closed instead of starting with fresh fixtures', async () => {
  await withDatabase(async databasePath => {
    await writeFile(databasePath, 'not a SQLite database');
    assert.throws(() => createReturnServer({ qa: false, databasePath }),
      error => error.name === 'StorageError' && !error.message.includes(databasePath));
  });
});

test('a receipt write failure rolls back the approval and allows the same request to retry', async () => {
  await withDatabase(async databasePath => {
    await withServer(false, async url => {
      const initial = await getRecord(url);
      const key = randomUUID();
      const connection = new DatabaseSync(databasePath);
      try {
        connection.exec(`
          CREATE TRIGGER fail_receipt BEFORE INSERT ON approval_receipts
          BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END;
        `);
        const failed = await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key);
        assert.equal(failed.status, 503);
        assert.equal((await failed.json()).code, 'STORAGE_UNAVAILABLE');
        assert.deepEqual(await getRecord(url), initial);

        connection.exec('DROP TRIGGER fail_receipt');
        const retried = await approve(url, 'RET-2418', initial.etag, '민서', '상태 확인', key);
        assert.equal(retried.status, 200);
        const latest = await getRecord(url);
        assert.equal(latest.record.events.filter(event => event.label === '검수 승인').length, 1);
      } finally {
        connection.close();
      }
    }, databasePath);
  });
});

test('unexpected Host and cross-origin mutations are rejected before state changes', async () => {
  await withServer(true, async url => {
    const initial = await getRecord(url);
    const wrongHost = await rawRequest(url, '/api/returns/RET-2418/approve', 'POST',
      { Host: 'remote.example', 'Content-Type': 'application/json', 'If-Match': initial.etag },
      JSON.stringify({ reviewer: '민서', memo: '승인 시도' }));
    assert.equal(wrongHost.status, 421);
    assert.equal(wrongHost.body.code, 'MISDIRECTED_REQUEST');

    const crossOrigin = await rawRequest(url, '/api/returns/RET-2418/approve', 'POST',
      { 'Content-Type': 'application/json', 'If-Match': initial.etag, Origin: 'https://remote.example' },
      JSON.stringify({ reviewer: '민서', memo: '승인 시도' }));
    assert.equal(crossOrigin.status, 403);
    assert.equal(crossOrigin.body.code, 'INVALID_ORIGIN');
    const qaCrossOrigin = await rawRequest(url, '/__qa/fault', 'PUT',
      { 'Content-Type': 'application/json', Origin: 'https://remote.example' }, JSON.stringify({ on: true }));
    assert.equal(qaCrossOrigin.status, 403);
    assert.deepEqual(await getRecord(url), initial);
    const port = new URL(url).port;
    const sameOrigin = await rawRequest(url, '/api/returns/RET-2418/approve', 'POST', {
      Host: `localhost:${port}`, Origin: `http://localhost:${port}`,
      'Content-Type': 'application/json', 'If-Match': initial.etag,
    }, JSON.stringify({ reviewer: '민서', memo: '정상 승인' }));
    assert.equal(sameOrigin.status, 200);
  });
});
