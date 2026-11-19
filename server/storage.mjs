import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class StorageError extends Error {
  constructor(message = '반품 검수 저장소를 사용할 수 없습니다.') {
    super(message);
    this.name = 'StorageError';
  }
}

function versionTag(record) {
  return `"${record.version}"`;
}

export function openReturnStorage({ databasePath, fixtures }) {
  if (databasePath !== undefined && (typeof databasePath !== 'string' || !isAbsolute(databasePath))) {
    throw new StorageError('저장소 경로는 절대경로여야 합니다.');
  }

  let database;
  try {
    database = new DatabaseSync(databasePath ?? ':memory:');
    database.exec('PRAGMA busy_timeout = 5000');
    if (databasePath) database.exec('PRAGMA journal_mode = WAL');
    database.exec(`
      CREATE TABLE IF NOT EXISTS return_records (
        id TEXT PRIMARY KEY,
        ordinal INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS approval_receipts (
        idempotency_key TEXT PRIMARY KEY,
        record_id TEXT NOT NULL,
        if_match TEXT NOT NULL,
        reviewer TEXT NOT NULL,
        memo TEXT NOT NULL,
        response_json TEXT NOT NULL,
        etag TEXT NOT NULL
      );
    `);

    const seed = database.prepare('INSERT INTO return_records (id, ordinal, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING');
    database.exec('BEGIN IMMEDIATE');
    try {
      fixtures.forEach((record, ordinal) => seed.run(record.id, ordinal, JSON.stringify(record)));
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }

    const listRecords = database.prepare('SELECT payload FROM return_records ORDER BY ordinal, id');
    const findRecord = database.prepare('SELECT payload FROM return_records WHERE id = ?');
    const findReceipt = database.prepare('SELECT * FROM approval_receipts WHERE idempotency_key = ?');
    const updateRecord = database.prepare('UPDATE return_records SET payload = ? WHERE id = ?');
    const insertReceipt = database.prepare(`
      INSERT INTO approval_receipts (idempotency_key, record_id, if_match, reviewer, memo, response_json, etag)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const safely = operation => {
      try {
        return operation();
      } catch {
        throw new StorageError();
      }
    };

    return {
      list() {
        return safely(() => listRecords.all().map(row => JSON.parse(row.payload)));
      },
      get(id) {
        return safely(() => {
          const row = findRecord.get(id);
          return row ? JSON.parse(row.payload) : undefined;
        });
      },
      approve({ id, ifMatch, reviewer, memo, key, unavailable }) {
        return safely(() => {
          database.exec('BEGIN IMMEDIATE');
          try {
            const row = findRecord.get(id);
            if (!row) {
              database.exec('COMMIT');
              return { kind: 'notFound' };
            }
            const record = JSON.parse(row.payload);
            const receipt = key ? findReceipt.get(key) : undefined;
            if (receipt) {
              if (receipt.record_id !== id || receipt.if_match !== ifMatch ||
                  receipt.reviewer !== reviewer || receipt.memo !== memo) {
                database.exec('COMMIT');
                return { kind: 'reusedKey' };
              }
              database.exec('COMMIT');
              return { kind: 'replay', record: JSON.parse(receipt.response_json), etag: receipt.etag };
            }
            if (unavailable) {
              database.exec('COMMIT');
              return { kind: 'unavailable' };
            }
            if (ifMatch !== versionTag(record)) {
              database.exec('COMMIT');
              return { kind: 'stale', record, etag: versionTag(record) };
            }
            if (record.status === 'approved') {
              database.exec('COMMIT');
              return { kind: 'alreadyApproved', record, etag: versionTag(record) };
            }

            record.status = 'approved';
            record.version += 1;
            record.events.push({
              id: randomUUID(), at: new Date().toISOString(), actor: reviewer,
              label: '검수 승인', ...(memo ? { memo } : {}),
            });
            const etag = versionTag(record);
            const payload = JSON.stringify(record);
            if (updateRecord.run(payload, id).changes !== 1) throw new StorageError();
            if (key) insertReceipt.run(key, id, ifMatch, reviewer, memo, payload, etag);
            database.exec('COMMIT');
            return { kind: 'approved', record, etag };
          } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* A failed commit may already have ended the transaction. */ }
            throw error;
          }
        });
      },
      close() {
        return safely(() => database.close());
      },
    };
  } catch {
    try { database?.close(); } catch { /* Preserve the original initialization failure. */ }
    throw new StorageError('반품 검수 저장소를 열 수 없습니다.');
  }
}
