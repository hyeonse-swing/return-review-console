import fixtures from '../shared/fixtures.json';
import type { ReturnDetail, ReturnRecord } from './api';

type ApprovalResult =
  | { kind: 'approved'; record: ReturnRecord; etag: string }
  | { kind: 'conflict'; record: ReturnRecord; etag: string }
  | { kind: 'failed' };

interface Receipt {
  key: string;
  recordId: string;
  ifMatch: string;
  reviewer: string;
  memo: string;
  record: ReturnRecord;
  etag: string;
}

const databaseName = 'return-review-console-web-demo-v1';
const seedRecords = fixtures as unknown as ReturnRecord[];
let databasePromise: Promise<IDBDatabase> | undefined;

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) {
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        const records = database.createObjectStore('records', { keyPath: 'id' });
        database.createObjectStore('receipts', { keyPath: 'key' });
        const metadata = database.createObjectStore('metadata');
        metadata.put(crypto.randomUUID(), 'generation');
        for (const record of seedRecords) records.add(record);
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          databasePromise = undefined;
        };
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = undefined;
        reject(request.error);
      };
      request.onblocked = () => {
        databasePromise = undefined;
        reject(new Error('The browser demo database is blocked by another tab.'));
      };
    });
  }
  return databasePromise;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function runTransaction<T>(stores: string[], mode: IDBTransactionMode, operation: (transaction: IDBTransaction) => Promise<T>): Promise<T> {
  const database = await openDatabase();
  const transaction = database.transaction(stores, mode);
  const completed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('Browser demo storage was interrupted.'));
    transaction.onerror = () => reject(transaction.error ?? new Error('Browser demo storage failed.'));
  });
  try {
    const result = await operation(transaction);
    await completed;
    return result;
  } catch (error) {
    try { transaction.abort(); } catch { /* The transaction may have already completed. */ }
    await completed.catch(() => {});
    throw error;
  }
}

function etag(generation: string, record: ReturnRecord): string {
  return `"${generation}:${record.version}"`;
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new DOMException('Request aborted', 'AbortError');
}

export async function demoQueue(signal: AbortSignal): Promise<ReturnRecord[]> {
  checkAbort(signal);
  const records = await runTransaction(['records'], 'readonly', transaction =>
    requestValue(transaction.objectStore('records').getAll() as IDBRequest<ReturnRecord[]>));
  checkAbort(signal);
  const byId = new Map(records.map(record => [record.id, record]));
  return seedRecords.map(record => {
    const current = byId.get(record.id);
    if (!current) throw new Error('Browser demo storage is missing a return record.');
    return current;
  });
}

export async function demoDetail(id: string, signal: AbortSignal): Promise<ReturnDetail> {
  checkAbort(signal);
  const detail = await runTransaction(['records', 'metadata'], 'readonly', async transaction => {
    const record = await requestValue(transaction.objectStore('records').get(id) as IDBRequest<ReturnRecord | undefined>);
    const generation = await requestValue(transaction.objectStore('metadata').get('generation') as IDBRequest<string>);
    if (!record) throw new Error('Return detail unavailable');
    return { record, etag: etag(generation, record) };
  });
  checkAbort(signal);
  return detail;
}

export async function demoApprove(detail: ReturnDetail, reviewer: string, memo: string, operationKey: string): Promise<ApprovalResult> {
  const name = reviewer.trim();
  const note = memo.trim();
  if (!name || name.length > 40 || note.length > 500 ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(operationKey)) {
    return { kind: 'failed' };
  }

  return runTransaction(['records', 'receipts', 'metadata'], 'readwrite', async transaction => {
    const records = transaction.objectStore('records');
    const receipts = transaction.objectStore('receipts');
    const current = await requestValue(records.get(detail.record.id) as IDBRequest<ReturnRecord | undefined>);
    const generation = await requestValue(transaction.objectStore('metadata').get('generation') as IDBRequest<string>);
    const receipt = await requestValue(receipts.get(operationKey.toLowerCase()) as IDBRequest<Receipt | undefined>);
    if (!current) return { kind: 'failed' };
    if (receipt) {
      if (receipt.recordId !== current.id || receipt.ifMatch !== detail.etag ||
          receipt.reviewer !== name || receipt.memo !== note) return { kind: 'failed' };
      return { kind: 'approved', record: receipt.record, etag: receipt.etag };
    }

    const currentEtag = etag(generation, current);
    if (detail.etag !== currentEtag || current.status === 'approved') {
      return { kind: 'conflict', record: current, etag: currentEtag };
    }

    const approved: ReturnRecord = {
      ...current,
      status: 'approved',
      version: current.version + 1,
      events: [...current.events, {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        actor: name,
        label: '검수 승인',
        ...(note ? { memo: note } : {}),
      }],
    };
    const approvedEtag = etag(generation, approved);
    records.put(approved);
    receipts.put({
      key: operationKey.toLowerCase(), recordId: current.id, ifMatch: detail.etag,
      reviewer: name, memo: note, record: approved, etag: approvedEtag,
    } satisfies Receipt);
    return { kind: 'approved', record: approved, etag: approvedEtag };
  });
}

export async function resetDemo(): Promise<void> {
  await runTransaction(['records', 'receipts', 'metadata'], 'readwrite', async transaction => {
    const records = transaction.objectStore('records');
    records.clear();
    transaction.objectStore('receipts').clear();
    transaction.objectStore('metadata').put(crypto.randomUUID(), 'generation');
    for (const record of seedRecords) records.put(record);
  });
}
