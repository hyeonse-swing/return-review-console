import { init } from '@ihyeon/browser-error-log';
import { Badge, Button } from '@hyeonse/design-system/primitives';
import { Textarea } from '@hyeonse/design-system/fields';
import { NativeDialog } from '@hyeonse/design-system/overlays';
import { ArrowDownLeft, ArrowRight, Check, ChevronRight, CircleAlert, Clock3, ListChecks, PackageCheck, RotateCw, Search, UserRound, Warehouse } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { approve, isWebDemo, loadDetail, loadQueue, resetWebDemo } from './api';
import type { ReturnDetail, ReturnRecord } from './api';
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
type StatusFilter = 'all' | ReturnRecord['status'];
const filters: StatusFilter[] = ['all', 'pending', 'approved'];
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

function formatDate(iso: string, language: Language, short = false) {
  return formatters[language][short ? 'short' : 'long'].format(new Date(iso));
}

function reviewDraft(id: string, reviewer: typeof reviewers[number], value?: string): string {
  const key = `return-review:draft:${id}:${reviewer}`;
  try {
    if (value === undefined) return sessionStorage.getItem(key) ?? '';
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch { /* The in-memory draft still works when session storage is unavailable. */ }
  return value ?? '';
}

function clearDemoDrafts() {
  try {
    for (let index = sessionStorage.length - 1; index >= 0; index--) {
      const key = sessionStorage.key(index);
      if (key?.startsWith('return-review:draft:')) sessionStorage.removeItem(key);
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
  return <Badge className={`return-status return-status--${record.status}`} tone={record.status === 'pending' ? 'warning' : 'success'}
    size="sm" data-testid={detailed ? 'record-status' : undefined}>
    <span aria-hidden="true" />{copy[language][record.status]}
  </Badge>;
}

function Approval({ current, reviewer, language, onUpdate }: {
  current: ReturnDetail;
  reviewer: typeof reviewers[number];
  language: Language;
  onUpdate: (updated: ReturnDetail) => void;
}) {
  const { record } = current;
  const t = copy[language];
  const [open, setOpen] = useState(false);
  const [memo, setMemo] = useState(() => reviewDraft(record.id, reviewer));
  const [message, setMessage] = useState<'conflict' | 'failed' | 'uncertain' | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const pendingOperation = useRef<{ key: string; reviewer: string; memo: string } | null>(null);
  const updatedStatus = useRef<HTMLParagraphElement>(null);
  const moveFocus = useRef(false);
  const dialogNotice = useRef<HTMLParagraphElement>(null);
  const approved = record.status === 'approved';
  const conflicted = message === 'conflict';
  const uncertain = message === 'uncertain';
  const approvedByCurrentReviewer = conflicted && record.events.some(event => event.label === '검수 승인' && event.actor === reviewer);

  useEffect(() => {
    if (approved && !open && moveFocus.current) {
      updatedStatus.current?.focus();
      moveFocus.current = false;
    }
  }, [approved, open]);

  useEffect(() => {
    if (message && open) dialogNotice.current?.focus();
  }, [message, open]);

  function changeOpen(next: boolean) {
    if (submitting.current) return;
    if (next && !pendingOperation.current) setMessage(null);
    if (!next && conflicted) moveFocus.current = true;
    setOpen(next);
  }

  async function confirm() {
    if (submitting.current || approved) return;
    submitting.current = true;
    setBusy(true);
    setMessage(null);
    const operation = pendingOperation.current ?? { key: crypto.randomUUID(), reviewer, memo };
    pendingOperation.current = operation;
    const result = await approve(current, operation.reviewer, operation.memo, operation.key);
    submitting.current = false;
    setBusy(false);
    if (result.kind === 'uncertain') {
      setMessage('uncertain');
      return;
    }
    pendingOperation.current = null;
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
          {approved ? t.approvalDone : uncertain ? t.approvalUnknown : t.approvalPrompt}
        </p>
        <p className="muted">{approved ? t.approvalDoneHint : uncertain ? t.approvalUnknownHint : t.approvalPromptHint}</p>
      </div>
      <NativeDialog title={t.dialogTitle} description={`${record.id} · ${displayFixture(record.item, language)}`} closeLabel={t.close} open={open} onOpenChange={changeOpen}
        trigger={<Button className="approve-button" size="lg" hidden={approved} disabled={approved}>{uncertain ? t.verifyApproval : t.approveReturn} <ArrowRight size={17} /></Button>}
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
    {approved && !open && memo && <p className="draft-note"><strong>{t.savedDraft}</strong> {memo}</p>}
  </>;
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
  const [reviewer, setReviewer] = useState<typeof reviewers[number]>(() => {
    try { return sessionStorage.getItem('return-review:reviewer') === '지훈' ? '지훈' : '민서'; }
    catch { return '민서'; }
  });
  const latestRecords = useRef(new Map<string, ReturnRecord>());
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [search, setSearch] = useState('');
  const [mobileDetail, setMobileDetail] = useState(() => new URLSearchParams(location.search).has('id'));
  const detailHeading = useRef<HTMLHeadingElement>(null);
  const queueHeading = useRef<HTMLHeadingElement>(null);
  const selectedButton = useRef<HTMLButtonElement>(null);
  const pending = queue.filter(record => record.status === 'pending').length;
  const query = search.trim().toLocaleLowerCase(language);
  const visible = queue.filter(record => (filter === 'all' || record.status === filter)
    && (!query || [record.id, record.item, displayFixture(record.item, language), record.sku]
      .some(value => value.toLocaleLowerCase(language).includes(query))));
  const record = detail?.record.id === selected ? detail.record : null;

  useEffect(() => {
    if (!demoChannel) return;
    function syncDemoReset(event: MessageEvent) {
      if (event.data !== 'reset') return;
      clearDemoDrafts();
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
    clearDemoDrafts();
    demoChannel?.postMessage('reset');
    refresh();
  }

  function update(next: ReturnDetail) {
    const known = latestRecords.current.get(next.record.id);
    if (known && known.version > next.record.version) return;
    latestRecords.current.set(next.record.id, next.record);
    setDetail(next);
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
          <div><dt><Clock3 size={16} aria-hidden="true" />{t.pending}</dt><dd>{pending}<span>{t.countSuffix(pending)}</span></dd></div>
          <div><dt><Check size={17} aria-hidden="true" />{t.approved}</dt><dd>{queue.length - pending}<span>{t.countSuffix(queue.length - pending)}</span></dd></div>
        </dl>
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
                    <span className="row-date">{language === 'ko' ? `${formatDate(item.receivedAt, language, true)} ${t.received}` : `${t.received} ${formatDate(item.receivedAt, language, true)}`}</span></span>
                  <span className="row-end"><Status record={item} language={language} /><ChevronRight size={17} aria-hidden="true" /></span>
                </button>
              </li>)}</ul>}
          </section>
          <section className="detail" aria-label={t.detail}>
            <button className="back-to-queue" type="button" onClick={() => {
              setMobileDetail(false);
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
                    <ol>{[...record.events].reverse().map(event => <li key={event.id}>
                      <span className="timeline-icon" aria-hidden="true">{event.label === '검수 승인' ? <Check size={14} /> : <ArrowDownLeft size={14} />}</span>
                      <div><strong>{displayFixture(event.label, language)}</strong><p>{displayName(event.actor, language)} <span aria-hidden="true">·</span> {formatDate(event.at, language)}</p>
                        {event.memo && <p className="event-memo">{displayMemo(event.id, event.memo, language)}</p>}</div>
                    </li>)}</ol>
                  </section>
                </div>
                <Approval key={`${record.id}:${reviewer}`} current={detail} reviewer={reviewer} language={language} onUpdate={update} />
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
