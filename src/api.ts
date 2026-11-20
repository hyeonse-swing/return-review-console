export interface ReturnRecord {
  id: string;
  item: string;
  sku: string;
  reason: string;
  receivedAt: string;
  condition: string;
  warehouse: string;
  status: 'pending' | 'held' | 'approved' | 'rejected';
  assignee?: string;
  version: number;
  customer: string;
  events: Array<{ id: string; at: string; actor: string; label: string; memo?: string }>;
}

export interface ReturnDetail {
  record: ReturnRecord;
  etag: string;
}

export const isWebDemo = import.meta.env.MODE === 'demo';

export async function resetWebDemo(): Promise<void> {
  if (isWebDemo) await (await import('./demo')).resetDemo();
}

function detailUrl(id: string) {
  return `/api/returns/${encodeURIComponent(id)}`;
}

export async function loadQueue(signal: AbortSignal): Promise<ReturnRecord[]> {
  if (isWebDemo) return (await import('./demo')).demoQueue(signal);
  const response = await fetch('/api/returns', { signal });
  if (!response.ok) throw new Error('Queue unavailable');
  const { records } = await response.json() as { records: ReturnRecord[] };
  return records;
}

export async function loadDetail(id: string, signal: AbortSignal): Promise<ReturnDetail> {
  if (isWebDemo) return (await import('./demo')).demoDetail(id, signal);
  const response = await fetch(detailUrl(id), { signal });
  const etag = response.headers.get('ETag');
  if (!response.ok || !etag) throw new Error('Return detail unavailable');
  const { record } = await response.json() as { record: ReturnRecord };
  return { record, etag };
}

export type ReviewCommand = 'approve' | 'hold' | 'reapprove' | 'reject';
export type AssignmentCommand = 'assign' | 'unassign';
export type ReviewResult =
  | { kind: 'approved'; record: ReturnRecord; etag: string }
  | { kind: 'conflict'; record: ReturnRecord; etag: string }
  | { kind: 'failed' }
  | { kind: 'uncertain' };

export async function submitReview(command: ReviewCommand | AssignmentCommand, detail: ReturnDetail, reviewer: string, memo: string, operationKey: string): Promise<ReviewResult> {
  try {
    if (isWebDemo) return await (await import('./demo')).demoReview(command, detail, reviewer, memo, operationKey);
    const response = await fetch(`${detailUrl(detail.record.id)}/${command}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': detail.etag, 'Idempotency-Key': operationKey },
      body: JSON.stringify({ reviewer, memo }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.ok || response.status === 412 || response.status === 409) {
      const { record } = await response.json() as { record?: ReturnRecord };
      if (record && typeof record.version === 'number') {
        const etag = response.headers.get('ETag') ?? `"${record.version}"`;
        return { kind: response.ok ? 'approved' : 'conflict', record, etag };
      }
      return { kind: response.ok ? 'uncertain' : 'failed' };
    }
    if (response.status === 503) {
      const { code } = await response.json() as { code?: string };
      return { kind: code === 'APPROVAL_UNAVAILABLE' || code === 'REVIEW_UNAVAILABLE' ? 'failed' : 'uncertain' };
    }
    return { kind: response.status < 500 ? 'failed' : 'uncertain' };
  } catch {
    return { kind: 'uncertain' };
  }
}

export function approve(detail: ReturnDetail, reviewer: string, memo: string, operationKey: string): Promise<ReviewResult> {
  return submitReview('approve', detail, reviewer, memo, operationKey);
}
