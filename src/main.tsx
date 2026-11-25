import { init } from '@ihyeon/browser-error-log';
import { Badge, Button } from '@hyeonse/design-system/primitives';
import { DataTable } from '@hyeonse/design-system/display';
import { Textarea } from '@hyeonse/design-system/fields';
import { NativeDialog } from '@hyeonse/design-system/overlays';
import { ArrowDownLeft, ArrowRight, Check, ChevronRight, CircleAlert, Clock3, ListChecks, PackageCheck, RotateCw, Search, UserRound, Warehouse } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { approve, isWebDemo, loadDetail, loadQueue, resetWebDemo, submitReview } from './api';
import type { AssignmentCommand, ReturnDetail, ReturnRecord, ReviewCommand } from './api';
import { copy, displayFixture, displayMemo, displayName, initialLanguage } from './i18n';
import type { Language } from './i18n';
import '@hyeonse/design-system/tokens.css';
import '@hyeonse/design-system/components.css';
import './style.css';

if (!isWebDemo) {
  init({
    project: 'return-review-console',
    endpoint: '/api/client-errors',
    preset: 'minimal',
    captureNetwork: true,
    shouldCaptureHttp: status => status >= 500,
    flushIntervalMs: 150,
  });
}

const demoChannel = isWebDemo && typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('return-review:demo')
  : null;

const reviewers = ['민서', '지훈'] as const;
type Reviewer = typeof reviewers[number];
type PendingApproval = { key: string; etag: string; memo: string };
type StatusFilter = 'all' | ReturnRecord['status'];
const filters: StatusFilter[] = ['all', 'pending', 'held', 'approved', 'rejected'];
const formatters = {
  ko: {
    long: new Intl.DateTimeFormat('ko-KR', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul' }),
    short: new Intl.DateTimeFormat('ko-KR', { month: '2-digit', day: '2-digit', timeZone: 'Asia/Seoul' }),
  },
  en: {
    long: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: 'Asia/Seoul' }),
    short: new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'Asia/Seoul' }),
  },
};
const startingLanguage = initialLanguage();
document.documentElement.lang = startingLanguage;
document.title = copy[startingLanguage].title;

function formatDate(value: string | number, language: Language, short = false) {
  return formatters[language][short ? 'short' : 'long'].format(new Date(value));
}

function lastHoldEvent(record: ReturnRecord) {
  return [...record.events].reverse().find(event => event.label === '검수 보류');
}

function reviewDraft(id: string, reviewer: Reviewer, value?: string, command: ReviewCommand = 'approve'): string {
  const key = `return-review:draft:${id}:${reviewer}${command === 'approve' ? '' : `:${command}`}`;
  try {
    if (value === undefined) return sessionStorage.getItem(key) ?? '';
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* The in-memory draft still works when session storage is unavailable. */ }
  return value ?? '';
}

function pendingApprovalKey(id: string, reviewer: Reviewer, command: ReviewCommand | AssignmentCommand = 'approve') {
  return `return-review:pending-${command === 'approve' ? 'approval' : command}:${id}:${reviewer}`;
}

function readPendingApproval(id: string, reviewer: Reviewer, command: ReviewCommand | AssignmentCommand = 'approve'): PendingApproval | null {
  try {
    const value = sessionStorage.getItem(pendingApprovalKey(id, reviewer, command));
    if (!value) return null;
    const operation: Partial<PendingApproval> | null = JSON.parse(value);
    if (typeof operation?.key === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(operation.key)
        && typeof operation.etag === 'string' && /^"(?:[a-f0-9-]{36}:)?[1-9]\d*"$/.test(operation.etag)
        && typeof operation.memo === 'string' && operation.memo.length <= 500) {
      return { key: operation.key, etag: operation.etag, memo: operation.memo };
    }
  } catch { /* Invalid or unavailable storage leaves the tab in its default state. */ }
  return null;
}

function writePendingApproval(id: string, reviewer: Reviewer, operation: PendingApproval | null, command: ReviewCommand | AssignmentCommand = 'approve') {
  try {
    const key = pendingApprovalKey(id, reviewer, command);
    if (operation) sessionStorage.setItem(key, JSON.stringify(operation));
    else sessionStorage.removeItem(key);
  } catch { /* The current component retains the request when storage is unavailable. */ }
}

function clearDemoReviewState() {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith('return-review:draft:') || key?.startsWith('return-review:pending-')) {
        sessionStorage.removeItem(key);
      }
    }
  } catch { /* The browser may block session storage. */ }
}

function updateLocation(id: string | null) {
  const url = new URL(location.href);
  if (id) url.searchParams.set('id', id);
  else url.searchParams.delete('id');
  history.replaceState(null, '', url);
}

function Status({ record, language, detailed = false }: { record: ReturnRecord; language: Language; detailed?: boolean }) {
  return <Badge className={`return-status return-status--${record.status}`} tone={record.status === 'approved' ? 'success' : 'warning'}
    size="sm" data-testid={detailed ? 'record-status' : undefined}>
    <span aria-hidden="true" />{copy[language][record.status]}
  </Badge>;
}

function HistoryCopy({ record, language }: { record: ReturnRecord; language: Language }) {
  const t = copy[language];
  const [result, setResult] = useState<'copied' | 'failed' | null>(null);

  async function copyHistory() {
    const lines = [
      `${t.returnId}: ${record.id}`,
      `${t.reviewStatus}: ${t[record.status]}`,
      `${t.history}:`,
      ...record.events.map(event => {
        const heading = `${event.at} · ${displayFixture(event.label, language)} · ${displayName(event.actor, language)}`;
        const memo = event.memo ? `\n${displayMemo(event.id, event.memo, language)}` : '';
        return `${heading}${memo}`;
      }),
    ];
    try {
      await navigator.clipboard.writeText(lines.join('\n'));
      setResult('copied');
    } catch {
      setResult('failed');
    }
  }

  return <>
    <Button variant="secondary" size="sm" onClick={copyHistory}>{t.copyHistory}</Button>
    <p role="status">{result === 'copied' ? t.historyCopied : result === 'failed' ? t.historyCopyFailed : ''}</p>
  </>;
}

function Approval({ current, reviewer, language, onUpdate }: {
  current: ReturnDetail;
  reviewer: Reviewer;
  language: Language;
  onUpdate: (updated: ReturnDetail) => void;
}) {
  const { record } = current;
  const t = copy[language];
  const [open, setOpen] = useState(false);
  const [pendingOperation, setPendingOperation] = useState(() => readPendingApproval(record.id, reviewer));
  const [memo, setMemo] = useState(() => pendingOperation?.memo ?? reviewDraft(record.id, reviewer));
  const [message, setMessage] = useState<'conflict' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const updatedStatus = useRef<HTMLParagraphElement>(null);
  const moveFocus = useRef(false);
  const dialogNotice = useRef<HTMLParagraphElement>(null);
  const approved = record.status === 'approved';
  const changed = record.status === 'held' || record.status === 'rejected';
  const conflicted = message === 'conflict';
  const canConfirm = record.status === 'pending' || pendingOperation !== null;
  const uncertain = pendingOperation !== null && !busy;
  const approvedByCurrentReviewer = conflicted && record.events.some(event => event.label === '검수 승인' && event.actor === reviewer);

  useEffect(() => {
    if ((approved || changed) && !open && moveFocus.current) {
      updatedStatus.current?.focus();
      moveFocus.current = false;
    }
  }, [approved, changed, open]);

  useEffect(() => {
    if ((message || uncertain) && open) dialogNotice.current?.focus();
  }, [message, uncertain, open]);

  function changeOpen(next: boolean) {
    if (submitting.current) return;
    if (next) setMessage(null);
    if (!next && conflicted) moveFocus.current = true;
    setOpen(next);
  }

  if ((record.status === 'held' || record.status === 'rejected') && !pendingOperation && !conflicted) return null;

  async function confirm() {
    if (submitting.current || !canConfirm) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    const operation = pendingOperation ?? { key: crypto.randomUUID(), etag: current.etag, memo };
    writePendingApproval(record.id, reviewer, operation);
    setPendingOperation(operation);
    const result = await approve({ ...current, etag: operation.etag }, reviewer, operation.memo, operation.key);
    submitting.current = false;
    setBusy(false);
    if (result.kind === 'uncertain') return;
    writePendingApproval(record.id, reviewer, null);
    setPendingOperation(null);
    if (result.kind === 'failed') {
      setMessage('failed');
      return;
    }
    onUpdate({ record: result.record, etag: result.etag });
    if (result.kind === 'conflict') {
      setMessage('conflict');
      return;
    }
    reviewDraft(record.id, reviewer, '');
    setMemo('');
    moveFocus.current = true;
    setOpen(false);
  }

  return <>
    <div className="approval-bar">
      <div>
        <p className="approval-label" ref={updatedStatus} tabIndex={-1}>
          {uncertain ? t.approvalUnknown : approved ? t.approvalDone : changed ? t.approvalChanged : t.approvalPrompt}
        </p>
        <p className="muted">{uncertain ? t.approvalUnknownHint : approved ? t.approvalDoneHint : changed ? t.approvalChangedHint : t.approvalPromptHint}</p>
      </div>
      <NativeDialog title={t.dialogTitle} description={`${record.id} · ${displayFixture(record.item, language)}`} closeLabel={t.close} open={open} onOpenChange={changeOpen}
        trigger={<Button className="approve-button" size="lg" hidden={!canConfirm} disabled={!canConfirm}>{uncertain ? t.verifyApproval : t.approveReturn} <ArrowRight size={17} /></Button>}
        footer={<>
          <Button variant="secondary" onClick={() => changeOpen(false)} disabled={busy}>{conflicted ? t.closeAndHistory : uncertain ? t.later : t.cancel}</Button>
          {!conflicted && <Button type="submit" form="approval-form" loading={busy} loadingLabel={t.approving}>{uncertain ? t.retrySameRequest : t.confirmApproval}</Button>}
        </>}>
        <form id="approval-form" className="approval-form" onSubmit={event => { event.preventDefault(); void confirm(); }}>
          <p className="reviewer-line"><UserRound size={16} aria-hidden="true" />{t.reviewerApproval(displayName(reviewer, language))}</p>
          {message === 'failed' && <p className="notice notice--error" role="alert" ref={dialogNotice} tabIndex={-1}><CircleAlert size={18} aria-hidden="true" />{t.failed}</p>}
          {uncertain && <p className="notice notice--error" role="alert" ref={dialogNotice} tabIndex={-1}>
            <CircleAlert size={18} aria-hidden="true" />{t.uncertainNotice}
          </p>}
          {conflicted && <p className="notice" role="alert" ref={dialogNotice} tabIndex={-1}>
            <CircleAlert size={18} aria-hidden="true" />{approvedByCurrentReviewer ? t.conflictSelf : t.conflictOther}{t.conflictFollowup}
          </p>}
          <Textarea label={t.memo} hint={conflicted ? undefined : t.memoHint} rows={4} maxLength={500}
            value={memo} readOnly={conflicted || busy || uncertain} onChange={event => setMemo(reviewDraft(record.id, reviewer, event.target.value))} />
        </form>
      </NativeDialog>
    </div>
    {approved && !open && !uncertain && memo && <p className="draft-note"><strong>{t.savedDraft}</strong> {memo}</p>}
  </>;
}

function ReviewDecision({ command, current, reviewer, language, onUpdate }: {
  command: Exclude<ReviewCommand, 'approve'>;
  current: ReturnDetail;
  reviewer: Reviewer;
  language: Language;
  onUpdate: (updated: ReturnDetail) => void;
}) {
  const { record } = current;
  const t = copy[language];
  const [open, setOpen] = useState(false);
  const [pendingOperation, setPendingOperation] = useState(() => readPendingApproval(record.id, reviewer, command));
  const [memo, setMemo] = useState(() => pendingOperation?.memo ?? reviewDraft(record.id, reviewer, undefined, command));
  const [message, setMessage] = useState<'conflict' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const notice = useRef<HTMLParagraphElement>(null);
  const allowed = command === 'hold' ? record.status === 'pending' : record.status === 'held';
  const required = command === 'hold' || command === 'reject';
  const uncertain = pendingOperation !== null && !busy;
  const label = command === 'hold' ? t.holdReturn : command === 'reject' ? t.rejectReturn : t.reapproveReturn;
  const title = command === 'hold' ? t.holdDialog : command === 'reject' ? t.rejectDialog : t.reapproveDialog;
  const confirmLabel = command === 'hold' ? t.confirmHold : command === 'reject' ? t.confirmReject : t.confirmReapprove;
  const busyLabel = command === 'hold' ? t.holding : command === 'reject' ? t.rejecting : t.reapproving;
  const hint = command === 'hold' ? t.holdReasonHint : command === 'reject' ? t.rejectReasonHint : t.memoHint;

  useEffect(() => {
    if ((message || uncertain) && open) notice.current?.focus();
  }, [message, uncertain, open]);

  async function confirm() {
    if (submitting.current || (!allowed && !pendingOperation) || (required && !memo.trim() && !pendingOperation)) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    const operation = pendingOperation ?? { key: crypto.randomUUID(), etag: current.etag, memo };
    writePendingApproval(record.id, reviewer, operation, command);
    setPendingOperation(operation);
    const result = await submitReview(command, { ...current, etag: operation.etag }, reviewer, operation.memo, operation.key);
    submitting.current = false;
    setBusy(false);
    if (result.kind === 'uncertain') return;
    writePendingApproval(record.id, reviewer, null, command);
    setPendingOperation(null);
    if (result.kind === 'failed') {
      setMessage('failed');
      return;
    }
    onUpdate({ record: result.record, etag: result.etag });
    if (result.kind === 'conflict') {
      setMessage('conflict');
      return;
    }
    reviewDraft(record.id, reviewer, '', command);
    setMemo('');
    setOpen(false);
  }

  if (!allowed && !pendingOperation && message !== 'conflict') return null;
  return <div className="decision-bar">
    <NativeDialog title={title} description={`${record.id} · ${displayFixture(record.item, language)}`} closeLabel={t.close}
      open={open} onOpenChange={next => {
        if (submitting.current) return;
        if (next || message === 'conflict') setMessage(null);
        setOpen(next);
      }}
      trigger={<Button variant={command === 'reject' || command === 'hold' ? 'secondary' : 'primary'} size="lg">
        {uncertain ? t.verifyDecision : label}<ArrowRight size={17} />
      </Button>}
      footer={<>
        <Button variant="secondary" onClick={() => { setOpen(false); if (message === 'conflict') setMessage(null); }} disabled={busy}>{message === 'conflict' ? t.closeAndHistory : t.cancel}</Button>
        {message !== 'conflict' && <Button type="submit" form={`review-${command}-form`} loading={busy} loadingLabel={busyLabel}
          disabled={!uncertain && required && !memo.trim()}>{uncertain ? t.retrySameRequest : confirmLabel}</Button>}
      </>}>
      <form id={`review-${command}-form`} className="approval-form" onSubmit={event => { event.preventDefault(); void confirm(); }}>
        <p className="reviewer-line"><UserRound size={16} aria-hidden="true" />{t.reviewerApproval(displayName(reviewer, language))}</p>
        {message === 'failed' && <p className="notice notice--error" role="alert" ref={notice} tabIndex={-1}><CircleAlert size={18} aria-hidden="true" />{t.decisionFailed}</p>}
        {uncertain && <p className="notice notice--error" role="alert" ref={notice} tabIndex={-1}><CircleAlert size={18} aria-hidden="true" />{t.decisionUncertain}</p>}
        {message === 'conflict' && <p className="notice" role="alert" ref={notice} tabIndex={-1}><CircleAlert size={18} aria-hidden="true" />{t.conflictOther}{t.conflictFollowup}</p>}
        <Textarea label={required ? t.decisionReason : t.memo} hint={hint} rows={4} maxLength={500}
          value={memo} readOnly={message === 'conflict' || busy || uncertain}
          onChange={event => setMemo(reviewDraft(record.id, reviewer, event.target.value, command))} />
      </form>
    </NativeDialog>
  </div>;
}

type PendingAssignment = PendingApproval & { command: AssignmentCommand };

function Assignment({ current, reviewer, language, onUpdate }: {
  current: ReturnDetail;
  reviewer: Reviewer;
  language: Language;
  onUpdate: (updated: ReturnDetail) => void;
}) {
  const { record } = current;
  const t = copy[language];
  const [pending, setPending] = useState<PendingAssignment | null>(() => {
    const assign = readPendingApproval(record.id, reviewer, 'assign');
    const unassign = readPendingApproval(record.id, reviewer, 'unassign');
    return assign ? { ...assign, command: 'assign' } : unassign ? { ...unassign, command: 'unassign' } : null;
  });
  const [message, setMessage] = useState<'conflict' | 'failed' | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const action = pending?.command ?? (record.status !== 'held' ? null
    : !record.assignee ? 'assign' : record.assignee === reviewer ? 'unassign' : null);
  const notice = pending && !busy ? t.assignmentUncertain
    : message === 'conflict' ? t.assignmentConflict : message === 'failed' ? t.assignmentFailed : null;

  async function changeAssignment() {
    if (submitting.current || !action) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    const operation: PendingAssignment = pending ?? {
      command: action, key: crypto.randomUUID(), etag: current.etag, memo: '',
    };
    writePendingApproval(record.id, reviewer, operation, operation.command);
    setPending(operation);
    const result = await submitReview(operation.command, { ...current, etag: operation.etag },
      reviewer, '', operation.key);
    submitting.current = false;
    setBusy(false);
    if (result.kind === 'uncertain') return;
    writePendingApproval(record.id, reviewer, null, operation.command);
    setPending(null);
    if (result.kind === 'failed') {
      setMessage('failed');
      return;
    }
    onUpdate({ record: result.record, etag: result.etag });
    if (result.kind === 'conflict') setMessage('conflict');
  }

  if (record.status !== 'held' && !pending && !message) return null;
  return <section className="assignment" aria-label={t.assignee}>
    {record.status === 'held' && <p><strong>{t.assignee}</strong> {record.assignee ? displayName(record.assignee, language) : t.unassigned}</p>}
    {action && <Button variant="secondary" size="sm" disabled={busy} onClick={() => void changeAssignment()}>
      {pending ? t.retrySameRequest : action === 'assign' ? t.assignReturn : t.unassignReturn}
    </Button>}
    {notice && <p className="assignment-notice" role="alert">{notice}</p>}
  </section>;
}

function DemoNotice({ language, onReset }: { language: Language; onReset: () => void }) {
  const t = copy[language];
  const [open, setOpen] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [resetDone, setResetDone] = useState(false);

  async function reset() {
    if (resetting) return;
    setFailed(false);
    setResetting(true);
    try {
      await resetWebDemo();
      onReset();
      setResetDone(true);
      setOpen(false);
    } catch {
      setFailed(true);
    } finally {
      setResetting(false);
    }
  }

  return <section className="web-demo" aria-label={t.demoWorkspace} data-testid="web-demo">
    <div>
      <p><strong>{t.demoWorkspace}</strong> {t.webDemoStorage}</p>
      <p>{t.webDemoConflict}</p>
      {resetDone && <p role="status">{t.demoResetDone}</p>}
    </div>
    <NativeDialog title={t.demoReset} description={t.demoResetDescription} closeLabel={t.close}
      open={open} onOpenChange={value => {
        if (resetting) return;
        if (value) {
          setFailed(false);
          setResetDone(false);
        }
        setOpen(value);
      }}
      trigger={<Button variant="secondary" data-testid="reset-demo">{t.demoReset}</Button>}
      footer={<>
        <Button variant="secondary" disabled={resetting} onClick={() => setOpen(false)}>{t.cancel}</Button>
        <Button data-testid="confirm-reset-demo" loading={resetting} onClick={() => void reset()}>{t.demoResetConfirm}</Button>
      </>}>
      {failed && <p role="alert">{t.demoResetError}</p>}
    </NativeDialog>
  </section>;
}

function App() {
  const [language, setLanguage] = useState<Language>(startingLanguage);
  const t = copy[language];
  const [queue, setQueue] = useState<ReturnRecord[]>([]);
  const [queueProblem, setQueueProblem] = useState(false);
  const [queueLoading, setQueueLoading] = useState(true);
  const [detailProblem, setDetailProblem] = useState(false);
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState<string | null>(() => new URLSearchParams(location.search).get('id'));
  const [detail, setDetail] = useState<ReturnDetail | null>(null);
  const [reviewer, setReviewer] = useState<Reviewer>(() => {
    try { return sessionStorage.getItem('return-review:reviewer') === '지훈' ? '지훈' : '민서'; }
    catch { return '민서'; }
  });
  const latestRecords = useRef(new Map<string, ReturnRecord>());
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [heldSort, setHeldSort] = useState<{ columnId: string; direction: 'asc' | 'desc' } | null>({
    columnId: 'receivedAt', direction: 'asc',
  });
  const [selectedHeldRowId, setSelectedHeldRowId] = useState<string | null>(null);
  const [heldPage, setHeldPage] = useState(1);
  const [assignmentFilter, setAssignmentFilter] = useState<'all' | 'mine' | 'unassigned'>('all');
  const [search, setSearch] = useState('');
  const [mobileDetail, setMobileDetail] = useState(() => new URLSearchParams(location.search).has('id'));
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const queueHeading = useRef<HTMLHeadingElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const counts = {
    pending: queue.filter(record => record.status === 'pending').length,
    held: queue.filter(record => record.status === 'held').length,
    approved: queue.filter(record => record.status === 'approved').length,
    rejected: queue.filter(record => record.status === 'rejected').length,
  };
  const query = search.trim().toLocaleLowerCase(language);
  const visible = queue.filter(record => (filter === 'all' || record.status === filter)
    && (!query || [record.id, record.item, displayFixture(record.item, language), record.sku]
      .some(value => value.toLocaleLowerCase(language).includes(query))));
  const held = queue.filter(item => {
    if (item.status !== 'held') return false;
    if (assignmentFilter === 'mine') return item.assignee === reviewer;
    if (assignmentFilter === 'unassigned') return !item.assignee;
    return true;
  });
  const heldEmptyMessages = { all: t.noHeldReturns, mine: t.noMine, unassigned: t.noUnassigned };
  const selectedStillHeld = held.some(item => item.id === selectedHeldRowId);
  const sortedHeld = held.map(item => {
    const event = lastHoldEvent(item);
    return { ...item, holdReason: event?.memo, heldSince: event ? Date.parse(event.at) : NaN };
  }).sort((left, right) => {
    if (!heldSort) return 0;
    const byHold = heldSort.columnId === 'heldSince';
    const a = byHold ? left.heldSince : Date.parse(left.receivedAt);
    const b = byHold ? right.heldSince : Date.parse(right.receivedAt);
    if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1;
    const direction = heldSort.direction === 'asc' ? 1 : -1;
    return direction * (a - b) || left.id.localeCompare(right.id);
  });
  const heldPageSize = 2;
  const heldPageCount = Math.max(1, Math.ceil(sortedHeld.length / heldPageSize));
  const visibleHeldPage = Math.min(heldPage, heldPageCount);
  const heldRows = sortedHeld.slice((visibleHeldPage - 1) * heldPageSize, visibleHeldPage * heldPageSize);
  const record = detail?.record.id === selected ? detail.record : null;

  useEffect(() => {
    if (heldPage > heldPageCount) setHeldPage(heldPageCount);
    if (selectedHeldRowId && !selectedStillHeld) {
      setSelectedHeldRowId(null);
    }
  }, [heldPage, heldPageCount, selectedHeldRowId, selectedStillHeld]);

  function toggleAssignmentFilter(filter: 'mine' | 'unassigned') {
    setAssignmentFilter(current => current === filter ? 'all' : filter);
    setHeldPage(1);
    setSelectedHeldRowId(null);
  }

  useEffect(() => {
    if (!demoChannel) return;
    function syncDemoReset(event: MessageEvent) {
      if (event.data !== 'reset') return;
      clearDemoReviewState();
      location.reload();
    }
    demoChannel.addEventListener('message', syncDemoReset);
    return () => demoChannel.removeEventListener('message', syncDemoReset);
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.title = t.title;
    try { localStorage.setItem('return-review:language', language); }
    catch { /* The current page keeps the selected language in memory. */ }
  }, [language, t.title]);

  function chooseLanguage(next: Language) {
    const url = new URL(location.href);
    url.searchParams.set('lang', next);
    history.replaceState(null, '', url);
    setLanguage(next);
  }

  useEffect(() => {
    const controller = new AbortController();
    loadQueue(controller.signal).then(records => {
      if (controller.signal.aborted) return;
      setQueue(records.map(item => {
        const known = latestRecords.current.get(item.id);
        const current = known && known.version > item.version ? known : item;
        latestRecords.current.set(item.id, current);
        return current;
      }));
      const linkedId = new URLSearchParams(location.search).get('id');
      if (linkedId && !records.some(item => item.id === linkedId)) updateLocation(records[0]?.id ?? null);
      setSelected(previous => records.some(item => item.id === previous) ? previous : records[0]?.id ?? null);
      setQueueLoading(false);
      setQueueProblem(false);
    }).catch(() => {
      if (controller.signal.aborted) return;
      setQueueLoading(false);
      setQueueProblem(true);
    });
    return () => controller.abort();
  }, [reload]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    loadDetail(selected, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const known = latestRecords.current.get(result.record.id);
      const record = known && known.version > result.record.version ? known : result.record;
      latestRecords.current.set(record.id, record);
      setDetailProblem(false);
      setDetail({ record, etag: record === result.record ? result.etag : `"${record.version}"` });
      setQueue(previous => previous.map(item => item.id === selected && item.version <= record.version ? record : item));
    }).catch(() => {
      if (!controller.signal.aborted) setDetailProblem(true);
    });
    return () => controller.abort();
  }, [selected, reload]);

  useEffect(() => {
    if (record && mobileDetail && window.matchMedia('(max-width: 800px)').matches) detailHeading.current?.focus();
  }, [record?.id, mobileDetail]);

  function select(id: string) {
    if (id === selected && detailProblem) refresh();
    setSelected(id);
    setDetailProblem(false);
    setMobileDetail(true);
    updateLocation(id);
  }

  function refresh() {
    latestRecords.current.clear();
    setQueueLoading(true);
    setQueueProblem(false);
    setDetailProblem(false);
    setDetail(null);
    setReload(previous => previous + 1);
  }

  function resetView() {
    clearDemoReviewState();
    demoChannel?.postMessage('reset');
    refresh();
  }

  function update(next: ReturnDetail) {
    const known = latestRecords.current.get(next.record.id);
    if (known && known.version > next.record.version) return;
    latestRecords.current.set(next.record.id, next.record);
    setDetail(previous => previous?.record.id === next.record.id ? next : previous);
    setQueue(previous => previous.map(item => item.id === next.record.id ? next.record : item));
  }

  return <div className="shell">
    <a className="skip" href="#main">{t.skip}</a>
    <aside className="rail" aria-label={t.workArea}>
      <div className="brand">
        <div className="brand-icon"><ArrowDownLeft size={22} strokeWidth={2.2} aria-hidden="true" /></div>
        <div><strong>{t.brand}</strong><span>{t.operations}</span></div>
      </div>
      <div className="rail-current"><PackageCheck size={19} aria-hidden="true" />{t.review}</div>
      <div className="rail-footer"><span aria-hidden="true" />{t.demoWorkspace}</div>
    </aside>
    <main id="main" className="main">
      <header className="topbar">
        <div className="breadcrumb"><Warehouse size={16} aria-hidden="true" />{t.operations} <ChevronRight size={13} aria-hidden="true" /><strong>{t.review}</strong></div>
        <div className="topbar-controls">
          <label className="language-picker"><span>{t.language}</span>
            <select aria-label={t.language} value={language} onChange={event => chooseLanguage(event.target.value as Language)}>
              <option value="ko" lang="ko">한국어</option>
              <option value="en" lang="en">English</option>
            </select>
          </label>
          <label className="reviewer"><UserRound size={17} aria-hidden="true" /><span>{t.reviewer}</span>
          <select aria-label={t.reviewer} value={reviewer} onChange={event => {
            const next = event.target.value as typeof reviewer;
            setReviewer(next);
            try { sessionStorage.setItem('return-review:reviewer', next); }
            catch { /* The current tab keeps the selected reviewer in memory. */ }
          }}>
            {reviewers.map(name => <option key={name} value={name}>{displayName(name, language)}</option>)}
          </select>
          </label>
        </div>
      </header>
      <div className="main-content">
        <div className="page-heading">
          <div><h1>{t.review}</h1><p>{t.pageDescription}</p></div>
          <Button variant="secondary" className="refresh" onClick={refresh} disabled={queueLoading}><RotateCw size={15} aria-hidden="true" />{t.refresh}</Button>
        </div>
        {isWebDemo && <DemoNotice language={language} onReset={resetView} />}
        <dl className="summary">
          <div><dt><ListChecks size={16} aria-hidden="true" />{t.allReturns}</dt><dd>{queue.length}<span>{t.countSuffix(queue.length)}</span></dd></div>
          <div><dt><Clock3 size={16} aria-hidden="true" />{t.pending}</dt><dd>{counts.pending}<span>{t.countSuffix(counts.pending)}</span></dd></div>
          <div><dt><CircleAlert size={17} aria-hidden="true" />{t.held}</dt><dd>{counts.held}<span>{t.countSuffix(counts.held)}</span></dd></div>
          <div><dt><Check size={17} aria-hidden="true" />{t.approved}</dt><dd>{counts.approved}<span>{t.countSuffix(counts.approved)}</span></dd></div>
          <div><dt><CircleAlert size={17} aria-hidden="true" />{t.rejected}</dt><dd>{counts.rejected}<span>{t.countSuffix(counts.rejected)}</span></dd></div>
        </dl>
        <section className="held-review" data-mobile-detail={mobileDetail}>
          <div className="held-controls">
            <button type="button" aria-pressed={assignmentFilter === 'unassigned'}
              onClick={() => toggleAssignmentFilter('unassigned')}>{t.unassigned}</button>
            <button type="button" aria-pressed={assignmentFilter === 'mine'}
              onClick={() => toggleAssignmentFilter('mine')}>{t.mineOnly}</button>
          </div>
          <DataTable
            caption={t.heldQueue}
            columns={[
              { id: 'id', header: t.returnId, cell: item => item.id },
              { id: 'receivedAt', header: t.receivedAt, sortable: true,
                cell: item => formatDate(item.receivedAt, language) },
              { id: 'heldSince', header: t.heldSince, sortable: true,
                cell: item => Number.isFinite(item.heldSince)
                  ? <time dateTime={new Date(item.heldSince).toISOString()}>{formatDate(item.heldSince, language)}</time>
                  : t.timeNotRecorded },
              { id: 'item', header: t.product, cell: item => displayFixture(item.item, language) },
              { id: 'reason', header: t.holdReason, cell: item =>
                <span className="held-reason-cell">{item.holdReason}</span> },
              { id: 'assignee', header: t.assignee, cell: item =>
                item.assignee ? displayName(item.assignee, language) : t.unassigned },
              { id: 'status', header: t.reviewStatus, cell: item => <Status record={item} language={language} /> },
              { id: 'details', header: t.detail, cell: item =>
                <button type="button" className="open-held-detail" onClick={() => select(item.id)}>{t.openDetail}</button> },
            ]}
            rows={heldRows}
            getRowId={item => item.id}
            getRowLabel={item => displayFixture(item.item, language)}
            sort={heldSort}
            onSortChange={next => { setHeldSort(next); setHeldPage(1); }}
            selectedRowId={selectedHeldRowId}
            onSelectedRowIdChange={setSelectedHeldRowId}
            page={visibleHeldPage}
            pageCount={heldPageCount}
            onPageChange={setHeldPage}
            totalRows={held.length}
            pageSize={heldPageSize}
            locale={language}
            state={queueProblem ? 'error' : queueLoading ? 'loading' : 'ready'}
            emptyMessage={heldEmptyMessages[assignmentFilter]}
            errorMessage={t.queueError}
          />
        </section>
        <div className="workbench" data-mobile-detail={mobileDetail}>
          <section className="queue" aria-labelledby="queue-heading">
            <div className="queue-controls">
              <h2 id="queue-heading" ref={queueHeading} tabIndex={-1}>{t.queue} <span>{visible.length}</span></h2>
              <label className="search"><Search size={18} aria-hidden="true" />
                <input type="search" aria-label={t.search} placeholder={t.searchPlaceholder} value={search} onChange={event => setSearch(event.target.value)} />
              </label>
              <div className="filters" role="group" aria-label={t.filterGroup}>
                {filters.map(key => <button type="button" key={key}
                  aria-pressed={filter === key} onClick={() => setFilter(key)}>{t[key]}</button>)}
              </div>
            </div>
            {queueProblem ? <p className="queue-message" role="alert">{t.queueError}</p>
              : queueLoading && queue.length === 0 ? <p className="queue-message" role="status">{t.queueLoading}</p>
              : visible.length === 0 ? <p className="queue-message" role="status">{t.queueEmpty}</p>
              : <ul className="records">{visible.map(item => <li key={item.id}>
                <button className="record-row" ref={item.id === selected ? selectedButton : undefined} type="button"
                  data-testid={`row-${item.id}`}
                  aria-current={item.id === selected ? 'true' : undefined} onClick={() => select(item.id)}>
                  <span className="row-copy"><span className="row-id">{item.id}</span><strong>{displayFixture(item.item, language)}</strong>
                    <span className="row-date">{language === 'ko' ? `${formatDate(item.receivedAt, language, true)} ${t.received}` : `${t.received} ${formatDate(item.receivedAt, language, true)}`}</span>
                    {item.status === 'held' && <>
                      <span className="row-hold-reason">{t.holdReason}: {lastHoldEvent(item)?.memo}</span>
                      <span className="row-assignee">{t.assignee}: {item.assignee ? displayName(item.assignee, language) : t.unassigned}</span>
                    </>}</span>
                  <span className="row-end"><Status record={item} language={language} /><ChevronRight size={17} aria-hidden="true" /></span>
                </button>
              </li>)}</ul>}
          </section>
          <section className="detail" aria-label={t.detail}>
            <button className="back-to-queue" type="button" onClick={() => {
              setMobileDetail(false);
              updateLocation(null);
              requestAnimationFrame(() => (selectedButton.current ?? queueHeading.current)?.focus());
            }}>
              <ArrowRight size={16} aria-hidden="true" />{t.queue}
            </button>
            {detailProblem ? <p className="queue-message" role="alert">{t.detailError}</p>
              : record && detail ? <>
                <header className="detail-header">
                  <div className="detail-kicker"><span>{record.id}</span><Status record={record} language={language} detailed /></div>
                  <h2 ref={detailHeading} tabIndex={-1}>{displayFixture(record.item, language)}</h2>
                  <p className="sku">SKU {record.sku}</p>
                </header>
                <div className="detail-body">
                  <section aria-labelledby="intake-heading">
                    <h3 id="intake-heading">{t.intake}</h3>
                    <dl className="facts">
                      <div><dt>{t.receivedAt}</dt><dd>{formatDate(record.receivedAt, language)}</dd></div>
                      <div><dt>{t.warehouse}</dt><dd>{displayFixture(record.warehouse, language)}</dd></div>
                      <div><dt>{t.reason}</dt><dd>{displayFixture(record.reason, language)}</dd></div>
                      <div><dt>{t.condition}</dt><dd>{displayFixture(record.condition, language)}</dd></div>
                    </dl>
                  </section>
                  <section className="history" aria-labelledby="history-heading">
                    <h3 id="history-heading">{t.history}</h3>
                    <HistoryCopy key={`${record.id}:${record.version}:${language}`} record={record} language={language} />
                    <ol>{[...record.events].reverse().map(event => <li key={event.id}>
                      <span className="timeline-icon" aria-hidden="true">{event.label.includes('승인') ? <Check size={14} /> : <ArrowDownLeft size={14} />}</span>
                      <div><strong>{displayFixture(event.label, language)}</strong><p>{displayName(event.actor, language)} <span aria-hidden="true">·</span> {formatDate(event.at, language)}</p>
                        {event.memo && <p className="event-memo">{displayMemo(event.id, event.memo, language)}</p>}</div>
                    </li>)}</ol>
                  </section>
                </div>
                {record.status === 'held' && <p className="hold-reason"><strong>{t.holdReason}</strong>{lastHoldEvent(record)?.memo}</p>}
                <Assignment key={`${record.id}:${reviewer}:assignment`} current={detail} reviewer={reviewer} language={language} onUpdate={update} />
                <Approval key={`${record.id}:${reviewer}:approval`} current={detail} reviewer={reviewer} language={language} onUpdate={update} />
                <div className="decision-actions" aria-label={t.reviewDecisions}>
                  <ReviewDecision key={`${record.id}:${reviewer}:hold`} command="hold" current={detail} reviewer={reviewer} language={language} onUpdate={update} />
                  <ReviewDecision key={`${record.id}:${reviewer}:reapprove`} command="reapprove" current={detail} reviewer={reviewer} language={language} onUpdate={update} />
                  <ReviewDecision key={`${record.id}:${reviewer}:reject`} command="reject" current={detail} reviewer={reviewer} language={language} onUpdate={update} />
                </div>
                {record.status === 'rejected' && <p className="decision-complete">{t.decisionComplete}</p>}
              </> : <p className="queue-message" role="status">{selected ? t.detailLoading : t.detailEmpty}</p>}
          </section>
        </div>
        {isWebDemo && <nav className="demo-links" aria-label={t.projectLinks}>
          <a href={`https://portfolio.hyeonse.dev/${language === 'en' ? 'en/' : ''}about/#return-review-console`}>{t.projectOverview}</a>
          <a href="https://github.com/hyeonse-swing/return-review-console">GitHub</a>
          <a href="https://www.npmjs.com/package/@ihyeon/return-review-console">{t.npmPackage}</a>
        </nav>}
      </div>
    </main>
  </div>;
}

createRoot(document.getElementById('root')!).render(<App />);
