import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openReturnStorage, StorageError } from './storage.mjs';
import fixtures from '../shared/fixtures.json' with { type: 'json' };

async function withDatabase(run) {
  const directory = await mkdtemp(join(tmpdir(), 'return-assignment-test-'));
  const path = join(directory, 'returns.sqlite');
  try {
    await run(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function transition(storage, command, ifMatch, reviewer, key = randomUUID()) {
  return storage.transition({
    command, id: 'RET-2418', ifMatch, reviewer, memo: '', key,
  });
}

test('held return assignment is versioned, exclusive, releasable, and ends with the decision', async () => {
  await withDatabase(async path => {
    const storage = openReturnStorage({ databasePath: path, fixtures });
    try {
      const before = storage.get('RET-2418');
      assert.equal(before.assignee, undefined);
      const hold = storage.transition({
        command: 'hold', id: before.id, ifMatch: `"${storage.workspaceId}:1"`,
        reviewer: '민서', memo: '실물 확인', key: randomUUID(),
      });
      assert.equal(hold.kind, 'committed');
      assert.equal(hold.record.assignee, undefined);

      const claimKey = randomUUID();
      const claim = transition(storage, 'assign', hold.etag, '민서', claimKey);
      const concurrent = transition(storage, 'assign', hold.etag, '지훈');
      assert.equal(claim.kind, 'committed');
      assert.equal(claim.record.assignee, '민서');
      assert.equal(concurrent.kind, 'stale');
      assert.equal(concurrent.record.assignee, '민서');
      assert.equal(transition(storage, 'assign', claim.etag, '지훈').kind, 'invalidTransition');
      assert.equal(transition(storage, 'unassign', claim.etag, '지훈').kind, 'invalidTransition');
      assert.deepEqual(transition(storage, 'assign', hold.etag, '민서', claimKey).record, claim.record);
      assert.equal(storage.get(before.id).events.filter(event => event.label === '재검수 담당').length, 1);

      const unassign = transition(storage, 'unassign', claim.etag, '민서');
      assert.equal(unassign.kind, 'committed');
      assert.equal(unassign.record.assignee, undefined);
      const secondClaim = transition(storage, 'assign', unassign.etag, '지훈');
      assert.equal(secondClaim.kind, 'committed');
      assert.equal(secondClaim.record.assignee, '지훈');

      const decision = storage.transition({
        command: 'reapprove', id: before.id, ifMatch: secondClaim.etag,
        reviewer: '민서', memo: '검수 완료', key: randomUUID(),
      });
      assert.equal(decision.kind, 'committed');
      assert.equal(decision.record.status, 'approved');
      assert.equal(decision.record.assignee, undefined);
      assert.equal(transition(storage, 'unassign', decision.etag, '지훈').kind, 'invalidTransition');
      assert.equal(storage.list().find(item => item.id === before.id).status, 'approved');
    } finally {
      storage.close();
    }
  });
});

test('assignment and its receipt survive restart and old records read as unassigned', async () => {
  await withDatabase(async path => {
    let storage = openReturnStorage({ databasePath: path, fixtures });
    const hold = storage.transition({
      command: 'hold', id: 'RET-2418', ifMatch: `"${storage.workspaceId}:1"`,
      reviewer: '민서', memo: '검수 보류', key: randomUUID(),
    });
    const key = randomUUID();
    const claim = transition(storage, 'assign', hold.etag, '민서', key);
    storage.close();

    storage = openReturnStorage({ databasePath: path, fixtures });
    try {
      assert.equal(storage.get('RET-2418').assignee, '민서');
      const replay = transition(storage, 'assign', hold.etag, '민서', key);
      assert.equal(replay.kind, 'replay');
      assert.deepEqual(replay.record, claim.record);
      assert.equal(transition(storage, 'unassign', hold.etag, '민서', key).kind, 'reusedKey');
      assert.equal(storage.get('RET-2421').assignee, undefined);
    } finally {
      storage.close();
    }
  });
});

test('failed receipt insertion rolls back assignment and permits the same request to retry', async () => {
  await withDatabase(async path => {
    const storage = openReturnStorage({ databasePath: path, fixtures });
    try {
      const hold = storage.transition({
        command: 'hold', id: 'RET-2418', ifMatch: `"${storage.workspaceId}:1"`,
        reviewer: '민서', memo: '검수 보류', key: randomUUID(),
      });
      const key = randomUUID();
      const connection = new DatabaseSync(path);
      try {
        connection.exec("CREATE TRIGGER fail_assignment_receipt BEFORE INSERT ON approval_receipts WHEN NEW.command = 'assign' BEGIN SELECT RAISE(ABORT, 'fail'); END");
        assert.throws(() => transition(storage, 'assign', hold.etag, '민서', key), StorageError);
        assert.equal(storage.get('RET-2418').assignee, undefined);
        assert.equal(storage.get('RET-2418').version, 2);
        connection.exec('DROP TRIGGER fail_assignment_receipt');
      } finally {
        connection.close();
      }
      assert.equal(transition(storage, 'assign', hold.etag, '민서', key).kind, 'committed');
      assert.equal(storage.get('RET-2418').events.filter(event => event.label === '재검수 담당').length, 1);
    } finally {
      storage.close();
    }
  });
});
