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
import fixtures from '../shared/fixtures.json' with { type: 'json' };

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

function nextTag(etag, version) {
  return etag.replace(/:[1-9]\d*"$/, `:${version}"`);
}

function approve(url, id, etag, reviewer, memo, key) {
  return fetch(`${url}/api/returns/${id}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag, ...(key ? { 'Idempotency-Key': key } : {}) },
    body: JSON.stringify({ reviewer, memo }),
  });
}

function review(url, id, command, etag, reviewer, memo, key = randomUUID()) {
  return fetch(`${url}/api/returns/${id}/${command}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': key },
    body: JSON.stringify({ reviewer, memo }),
  });
}

test('hold then reinspection preserves both decisions and rejects legacy approval on held records', async () => {
  await withServer(false, async url => {
    const before = await getRecord(url);
    const holdKey = randomUUID();
    const hold = await review(url, 'RET-2418', 'hold', before.etag, '민서', '실밥 상태 확인 필요', holdKey);
    assert.equal(hold.status, 200);
    const held = await hold.json();
    assert.equal(held.record.status, 'held');
    assert.equal(held.record.version, 2);
    assert.equal(held.record.events.at(-1).label, '검수 보류');
    assert.equal(held.record.events.at(-1).memo, '실밥 상태 확인 필요');

    const legacy = await approve(url, 'RET-2418', hold.headers.get('etag'), '지훈', '기존 클라이언트 승인');
    assert.equal(legacy.status, 409);
    assert.equal((await legacy.json()).code, 'INVALID_TRANSITION');

    const duplicate = await review(url, 'RET-2418', 'hold', before.etag, '민서', '실밥 상태 확인 필요', holdKey);
    assert.equal(duplicate.status, 200);
    assert.deepEqual((await duplicate.json()).record, held.record);
    const reused = await review(url, 'RET-2418', 'reject', before.etag, '민서', '실밥 상태 확인 필요', holdKey);
    assert.equal(reused.status, 409);
    assert.equal((await reused.json()).code, 'IDEMPOTENCY_KEY_REUSED');

    const etag = hold.headers.get('etag');
    const outcomes = await Promise.all([
      review(url, 'RET-2418', 'reapprove', etag, '지훈', '재검수에서 상태 확인'),
      review(url, 'RET-2418', 'reject', etag, '민서', '상태 불량 확인'),
    ]);
    assert.deepEqual(outcomes.map(response => response.status).sort(), [200, 412]);
    const latest = await getRecord(url);
    assert.equal(latest.record.version, 3);
    assert.equal(latest.record.events.length, before.record.events.length + 2);
    assert.equal(latest.record.events.at(-2).label, '검수 보류');
    assert.ok(['approved', 'rejected'].includes(latest.record.status));
    assert.equal((await review(url, 'RET-2418', 'hold', latest.etag, '민서', '재보류')).status, 409);
  });
});

test('required hold and rejection reasons reject empty and oversized input without state changes', async () => {
  await withServer(false, async url => {
    const before = await getRecord(url);
    for (const value of ['', '  ', 'x'.repeat(501)]) {
      const result = await review(url, 'RET-2418', 'hold', before.etag, '민서', value);
      assert.equal(result.status, 400);
    }
    assert.deepEqual(await getRecord(url), before);
    const hold = await review(url, 'RET-2418', 'hold', before.etag, '민서', '확인 필요');
    assert.equal(hold.status, 200);
    const held = await getRecord(url);
    assert.equal((await review(url, 'RET-2418', 'reject', held.etag, '지훈', ' ')).status, 400);
    assert.deepEqual(await getRecord(url), held);
  });
});

test('0.1.4 SQLite receipts and approvals survive migration to reinspection decisions', async () => {
  await withDatabase(async databasePath => {
    const old = new DatabaseSync(databasePath);
    old.exec(`CREATE TABLE return_records (id TEXT PRIMARY KEY, ordinal INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE approval_receipts (
        idempotency_key TEXT PRIMARY KEY, record_id TEXT NOT NULL, if_match TEXT NOT NULL,
        reviewer TEXT NOT NULL, memo TEXT NOT NULL, response_json TEXT NOT NULL, etag TEXT NOT NULL
      );`);
    const key = randomUUID();
    const approved = { ...fixtures[0], status: 'approved', version: 2, events: [
      ...fixtures[0].events, { id: randomUUID(), at: new Date().toISOString(), actor: '민서', label: '검수 승인', memo: '기존 승인' },
    ] };
    old.prepare('INSERT INTO return_records VALUES (?, ?, ?)').run(approved.id, 0, JSON.stringify(approved));
    old.prepare('INSERT INTO approval_receipts VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      key, approved.id, '"1"', '민서', '기존 승인', JSON.stringify(approved), '"2"',
    );
    old.close();

    await withServer(false, async url => {
      assert.deepEqual((await getRecord(url)).record, approved);
      const replay = await approve(url, approved.id, '"1"', '민서', '기존 승인', key);
      assert.equal(replay.status, 200);
      assert.deepEqual((await replay.json()).record, approved);
      const pending = await getRecord(url, 'RET-2421');
      const hold = await review(url, 'RET-2421', 'hold', pending.etag, '지훈', '실물 재확인');
      assert.equal(hold.status, 200);
      assert.equal((await hold.json()).record.status, 'held');
    }, databasePath);
    await withServer(false, async url => {
      assert.equal((await getRecord(url, 'RET-2421')).record.status, 'held');
      assert.deepEqual((await getRecord(url)).record, approved);
    }, databasePath);
  });
});

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
    assert.match(initial.etag, /^"[a-f0-9-]{36}:1"$/);
    assert.equal(initial.record.status, 'pending');

    const responses = await Promise.all([
      approve(url, 'RET-2418', initial.etag, '검수 담당 A', '택과 상품 상태 확인'),
      approve(url, 'RET-2418', initial.etag, '검수 담당 B', '오염 여부 확인'),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 412]);

    const stale = responses.find(response => response.status === 412);
    assert.equal(stale.headers.get('etag'), nextTag(initial.etag, 2));
    const staleBody = await stale.json();
    assert.equal(staleBody.code, 'STALE_VERSION');
    assert.equal(staleBody.record.status, 'approved');

    const latest = await getRecord(url);
    assert.equal(latest.etag, nextTag(initial.etag, 2));
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
    assert.equal(recovered.headers.get('etag'), nextTag(initial.etag, 2));
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
    assert.equal(replay.headers.get('etag'), nextTag(initial.etag, 2));
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

test('a stale tab cannot write to a different data folder with the same record version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'return-workspace-test-'));
  const firstPath = join(directory, 'first.sqlite');
  const secondPath = join(directory, 'second.sqlite');
  let firstEtag;
  let firstWorkspace;
  try {
    await withServer(false, async url => {
      const response = await fetch(`${url}/api/returns/RET-2418`);
      firstEtag = response.headers.get('etag');
      firstWorkspace = response.headers.get('x-workspace-id');
    }, firstPath);
    await withServer(false, async url => {
      const response = await fetch(`${url}/api/returns/RET-2418`);
      const secondEtag = response.headers.get('etag');
      assert.notEqual(secondEtag, firstEtag);
      assert.notEqual(response.headers.get('x-workspace-id'), firstWorkspace);
      for (const etag of [firstEtag, '"1"']) {
        const stale = await approve(url, 'RET-2418', etag, '민서', '첫 폴더의 메모', randomUUID());
        assert.equal(stale.status, 412);
        assert.equal((await stale.json()).record.status, 'pending');
      }
      assert.equal((await getRecord(url)).record.events.length, fixtures[0].events.length);
      assert.equal((await approve(url, 'RET-2418', secondEtag, '민서', '두 번째 폴더의 메모', randomUUID())).status, 200);
    }, secondPath);
    await withServer(false, async url => {
      assert.equal((await getRecord(url)).etag, firstEtag);
    }, firstPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('a replay identifies its saved receipt so the UI can load a later decision', async () => {
  await withServer(false, async url => {
    const before = await getRecord(url);
    const key = randomUUID();
    const hold = await review(url, 'RET-2418', 'hold', before.etag, '민서', '검수 보류', key);
    assert.equal(hold.status, 200);
    const heldEtag = hold.headers.get('etag');
    const reapprove = await review(url, 'RET-2418', 'reapprove', heldEtag, '지훈', '재검수 완료');
    assert.equal(reapprove.status, 200);
    const replay = await review(url, 'RET-2418', 'hold', before.etag, '민서', '검수 보류', key);
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('x-idempotency-replay'), '1');
    assert.equal((await replay.json()).record.status, 'held');
    assert.equal((await getRecord(url)).record.status, 'approved');
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
    let initialEtag;
    await withServer(true, async url => {
      const initial = await getRecord(url);
      initialEtag = initial.etag;
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
      assert.equal(latest.etag, nextTag(initialEtag, 2));
      assert.deepEqual(await (await fetch(`${url}/__qa/events`)).json(), { batches: [] });
      assert.equal((await setFault(url, true)).status, 200);

      const replay = await approve(url, 'RET-2418', initialEtag, ' 민서 ', ' 상태 확인 ', key);
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), approved);
      const conflict = await approve(url, 'RET-2418', initialEtag, '지훈', '상태 확인', key);
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

test('a hold receipt write failure rolls back the status and event together', async () => {
  await withDatabase(async databasePath => {
    await withServer(false, async url => {
      const before = await getRecord(url);
      const key = randomUUID();
      const connection = new DatabaseSync(databasePath);
      try {
        connection.exec(`CREATE TRIGGER fail_hold_receipt BEFORE INSERT ON approval_receipts
          BEGIN SELECT RAISE(ABORT, 'injected receipt write failure'); END;`);
        const failed = await review(url, before.record.id, 'hold', before.etag, '민서', '상태 다시 확인', key);
        assert.equal(failed.status, 503);
        assert.deepEqual(await getRecord(url), before);
        connection.exec('DROP TRIGGER fail_hold_receipt');
        const retried = await review(url, before.record.id, 'hold', before.etag, '민서', '상태 다시 확인', key);
        assert.equal(retried.status, 200);
        const latest = await getRecord(url);
        assert.equal(latest.record.status, 'held');
        assert.equal(latest.record.events.length, before.record.events.length + 1);
      } finally {
        connection.close();
      }
    }, databasePath);
  });
});

test('assignment API exposes the current owner on conflict and replays one history event', async () => {
  await withServer(false, async url => {
    const before = await getRecord(url);
    const hold = await review(url, before.record.id, 'hold', before.etag, '민서', '실물 확인');
    assert.equal(hold.status, 200);
    const heldEtag = hold.headers.get('etag');
    const missingKey = await fetch(`${url}/api/returns/${before.record.id}/assign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': heldEtag },
      body: JSON.stringify({ reviewer: '민서' }),
    });
    assert.equal(missingKey.status, 428);

    const firstKey = randomUUID();
    const secondKey = randomUUID();
    const results = await Promise.all([
      review(url, before.record.id, 'assign', heldEtag, '민서', '', firstKey),
      review(url, before.record.id, 'assign', heldEtag, '지훈', '', secondKey),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 412]);
    const winner = await results.find(result => result.status === 200).json();
    const loser = await results.find(result => result.status === 412).json();
    assert.equal(loser.record.assignee, winner.record.assignee);
    assert.equal(loser.record.version, winner.record.version);
    const owner = winner.record.assignee;
    const winningKey = owner === '민서' ? firstKey : secondKey;
    const replay = await review(url, before.record.id, 'assign', heldEtag, owner, '', winningKey);
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), winner);

    const latest = await getRecord(url);
    assert.equal(latest.record.events.filter(event => event.label === '재검수 담당').length, 1);
    const other = owner === '민서' ? '지훈' : '민서';
    assert.equal((await review(url, before.record.id, 'unassign', latest.etag, other, '')).status, 409);
    const unassigned = await review(url, before.record.id, 'unassign', latest.etag, owner, '');
    assert.equal(unassigned.status, 200);
    assert.equal((await unassigned.json()).record.assignee, undefined);
    const reassigned = await review(url, before.record.id, 'assign', unassigned.headers.get('etag'), other, '');
    assert.equal(reassigned.status, 200);
    const final = await review(url, before.record.id, 'reapprove', reassigned.headers.get('etag'), owner, '검수 완료');
    assert.equal(final.status, 200);
    assert.equal((await final.json()).record.assignee, undefined);
    assert.equal((await getRecord(url)).record.status, 'approved');
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
