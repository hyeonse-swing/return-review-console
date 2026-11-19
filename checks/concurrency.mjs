import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { createReturnServer } from '../server/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = join(root, 'output', 'browser');
await mkdir(output, { recursive: true });
const workspace = await mkdtemp(join(output, 'concurrency-'));
const server = createReturnServer({ qa: false });
let browser;

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const recordPath = '/api/returns/RET-2418';
  const app = new URL('/?id=RET-2418', origin).href;
  browser = await chromium.launch();
  const desktop = { viewport: { width: 1360, height: 900 } };
  const [first, second, mobile] = await Promise.all([
    browser.newPage(desktop),
    browser.newPage(desktop),
    browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true }),
  ]);
  for (const page of [first, second, mobile]) page.setDefaultTimeout(8_000);
  await Promise.all([first.goto(app), second.goto(app), mobile.goto(origin)]);
  await first.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
  await first.screenshot({ path: join(workspace, 'desktop.png'), fullPage: true });

  await mobile.getByRole('button', { name: /RET-2418/ }).click();
  await mobile.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Mobile layout overflows');
  await mobile.screenshot({ path: join(workspace, 'mobile.png'), fullPage: true });
  await mobile.getByRole('button', { name: '승인하기' }).click();
  await mobile.getByRole('dialog', { name: '반품 승인' }).waitFor();
  await mobile.keyboard.press('Escape');
  await mobile.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
  await mobile.waitForFunction(() => document.activeElement?.textContent?.trim() === '승인하기');
  await mobile.getByRole('button', { name: '반품 목록', exact: true }).click();
  await mobile.waitForFunction(() => document.activeElement?.textContent?.includes('RET-2418'));
  await mobile.goto(new URL('/?id=RET-9999', origin).href);
  await mobile.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
  assert.equal(new URL(mobile.url()).searchParams.get('id'), 'RET-2418');

  const staleDetailPage = await browser.newPage(desktop);
  staleDetailPage.setDefaultTimeout(8_000);
  let detailCaptured;
  const capturedDetail = new Promise(resolve => { detailCaptured = resolve; });
  let releaseDetail;
  const detailReleased = new Promise(resolve => { releaseDetail = resolve; });
  let approvedExternally;
  const externalApprovalDone = new Promise(resolve => { approvedExternally = resolve; });
  let oldDetail;
  let freshList;
  await staleDetailPage.route(url => new URL(url).pathname === '/api/returns/RET-2421', async route => {
    const response = await route.fetch();
    oldDetail = await response.json();
    detailCaptured();
    await detailReleased;
    await route.fulfill({ response });
  });
  await staleDetailPage.route(url => new URL(url).pathname === '/api/returns', async route => {
    await externalApprovalDone;
    const response = await route.fetch();
    freshList = await response.json();
    await route.fulfill({ response });
  });
  await staleDetailPage.goto(new URL('/?id=RET-2421', origin).href);
  await capturedDetail;
  assert.equal(oldDetail.record.status, 'pending');
  const detailForExternalApproval = await fetch(`${origin}/api/returns/RET-2421`);
  const externalApprovalResult = await fetch(`${origin}/api/returns/RET-2421/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': detailForExternalApproval.headers.get('etag'),
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ reviewer: '지훈', memo: '다른 탭에서 확인' }),
  });
  assert.equal(externalApprovalResult.status, 200);
  approvedExternally();
  await staleDetailPage.getByTestId('row-RET-2421').getByText('승인 완료').waitFor();
  assert.equal(freshList.records.find(item => item.id === 'RET-2421').version, 2);
  releaseDetail();
  await staleDetailPage.getByTestId('record-status').getByText('승인 완료').waitFor();

  const delayed = await browser.newPage(desktop);
  delayed.setDefaultTimeout(8_000);
  let releaseQueue;
  const queueReleased = new Promise(resolve => { releaseQueue = resolve; });
  let queueCaptured;
  const capturedQueue = new Promise(resolve => { queueCaptured = resolve; });
  let snapshot;
  await delayed.route(url => new URL(url).pathname === '/api/returns', async route => {
    const response = await route.fetch();
    snapshot = await response.json();
    queueCaptured();
    await queueReleased;
    await route.fulfill({ response });
  });
  await delayed.goto(new URL('/?id=RET-2423', origin).href);
  await capturedQueue;
  assert.equal(snapshot.records.find(item => item.id === 'RET-2423').status, 'pending');
  await delayed.getByRole('heading', { name: '리브 니트 카디건' }).waitFor();
  await delayed.getByRole('button', { name: '승인하기' }).click();
  await delayed.getByRole('button', { name: '승인 확정' }).click();
  await delayed.getByTestId('record-status').getByText('승인 완료').waitFor();
  const delayedResponse = delayed.waitForResponse(response => new URL(response.url()).pathname === '/api/returns');
  releaseQueue();
  await delayedResponse;
  await delayed.getByTestId('row-RET-2423').getByText('승인 완료').waitFor();
  await delayed.waitForFunction(() => {
    const values = [...document.querySelectorAll('.summary dd')].map(node => node.textContent?.replace(/\s+/g, ''));
    return values.join('|') === '6건|3건|3건';
  });

  const interrupted = await browser.newPage(desktop);
  interrupted.setDefaultTimeout(8_000);
  const interceptedRequests = [];
  await interrupted.route(url => new URL(url).pathname === '/api/returns/RET-2426/approve', async route => {
    const request = route.request();
    interceptedRequests.push({
      key: request.headers()['idempotency-key'],
      ifMatch: request.headers()['if-match'],
      body: request.postData(),
    });
    if (interceptedRequests.length === 1) {
      const committed = await route.fetch();
      assert.equal(committed.status(), 200);
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await interrupted.goto(new URL('/?id=RET-2426', origin).href);
  await interrupted.getByRole('heading', { name: '캔버스 로우 스니커즈' }).waitFor();
  await interrupted.getByRole('button', { name: '승인하기' }).click();
  const retryMemo = '반송 포장과 상품 확인';
  await interrupted.getByRole('textbox', { name: '검수 메모' }).fill(retryMemo);
  await interrupted.getByRole('button', { name: '승인 확정' }).click();
  await interrupted.getByRole('alert').getByText('승인 결과를 확인하지 못했어요. 같은 요청으로 다시 확인해 주세요.').waitFor();
  await interrupted.keyboard.press('Escape');
  await interrupted.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
  await interrupted.getByRole('button', { name: '승인 결과 확인' }).click();
  assert.equal(await interrupted.getByRole('textbox', { name: '검수 메모' }).getAttribute('readonly'), '');
  await interrupted.getByRole('button', { name: '같은 요청 재시도' }).click();
  await interrupted.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
  await interrupted.getByTestId('record-status').getByText('승인 완료').waitFor();
  assert.equal(interceptedRequests.length, 2);
  assert.match(interceptedRequests[0].key, /^[0-9a-f-]{36}$/);
  assert.deepEqual(interceptedRequests[0], interceptedRequests[1]);
  const interruptedRecord = await (await fetch(`${origin}/api/returns/RET-2426`)).json();
  assert.equal(interruptedRecord.record.events.filter(event => event.label === '검수 승인').length, 1);
  assert.equal(interruptedRecord.record.events.at(-1).memo, retryMemo);

  const sameReviewer = await browser.newPage(desktop);
  sameReviewer.setDefaultTimeout(8_000);
  await sameReviewer.goto(new URL('/?id=RET-2429', origin).href);
  await sameReviewer.getByRole('heading', { name: '오버사이즈 스트라이프 셔츠' }).waitFor();
  const sameRecordPath = '/api/returns/RET-2429';
  const staleDetail = await fetch(`${origin}${sameRecordPath}`);
  const externalApproval = await fetch(`${origin}${sameRecordPath}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': staleDetail.headers.get('etag'),
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ reviewer: '민서', memo: '동일 담당자의 다른 탭에서 승인' }),
  });
  assert.equal(externalApproval.status, 200);
  await sameReviewer.getByRole('button', { name: '승인하기' }).click();
  await sameReviewer.getByRole('button', { name: '승인 확정' }).click();
  await sameReviewer.getByRole('alert').getByText('이미 승인된 반품 건이에요.', { exact: false }).waitFor();
  assert.equal(await sameReviewer.getByRole('alert').getByText('다른 담당자가 먼저 처리했어요.').count(), 0);

  await second.getByRole('combobox', { name: '검수 담당자' }).selectOption('지훈');
  await second.getByRole('button', { name: '승인하기' }).click();
  await second.getByRole('textbox', { name: '검수 메모' }).fill('지훈 전용 초안');
  await second.getByRole('button', { name: '취소' }).click();
  await second.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
  await second.getByRole('combobox', { name: '검수 담당자' }).selectOption('민서');
  await second.getByRole('button', { name: '승인하기' }).click();
  assert.equal(await second.getByRole('textbox', { name: '검수 메모' }).inputValue(), '');
  await second.getByRole('textbox', { name: '검수 메모' }).fill('민서 전용 초안');
  await second.getByRole('button', { name: '취소' }).click();
  await second.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
  await second.getByRole('combobox', { name: '검수 담당자' }).selectOption('지훈');
  await second.getByRole('button', { name: '승인하기' }).click();
  assert.equal(await second.getByRole('textbox', { name: '검수 메모' }).inputValue(), '지훈 전용 초안');
  await second.getByRole('button', { name: '취소' }).click();
  await second.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
  for (const page of [first, second]) {
    const trigger = page.getByRole('button', { name: '승인하기' });
    await trigger.click();
    await page.getByRole('dialog', { name: '반품 승인' }).waitFor();
  }
  const winnerMemo = '택과 상품 상태를 확인했어요.';
  const draft = '구성품 확인이 필요해요.';
  await first.getByRole('textbox', { name: '검수 메모' }).fill(winnerMemo);
  await second.getByRole('textbox', { name: '검수 메모' }).fill(draft);

  async function submit(page, status) {
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === `${recordPath}/approve`
      && response.request().method() === 'POST');
    await page.getByRole('button', { name: '승인 확정' }).click();
    const response = await pending;
    assert.equal(response.status(), status);
    assert.equal(response.request().headers()['if-match'], '"1"');
    return response;
  }

  await submit(first, 200);
  await first.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
  await first.waitForFunction(() => document.activeElement?.textContent === '이 반품의 검수가 완료됐어요.');
  const lateResponse = await submit(second, 412);
  const late = await lateResponse.json();
  assert.equal(late.code, 'STALE_VERSION');
  assert.equal(late.record.version, 2);
  await second.getByRole('alert').filter({ hasText: '다른 담당자가 먼저 처리했어요.' }).waitFor();
  assert.equal(await second.getByRole('textbox', { name: '검수 메모' }).inputValue(), draft);
  assert.equal(await second.getByRole('button', { name: '승인 확정' }).count(), 0);
  await second.screenshot({ path: join(workspace, 'conflict.png'), fullPage: true });
  await second.getByRole('button', { name: '닫고 내역 보기' }).click();
  await second.getByText('보관된 검수 메모', { exact: true }).waitFor();
  await second.reload();
  assert.equal(await second.getByRole('combobox', { name: '검수 담당자' }).inputValue(), '지훈');
  await second.getByText(`보관된 검수 메모 ${draft}`, { exact: true }).waitFor();
  const result = await fetch(`${origin}${recordPath}`);
  const { record } = await result.json();
  const approvals = record.events.filter(event => event.label === '검수 승인');
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].actor, '민서');
  assert.equal(approvals[0].memo, winnerMemo);

  const suite = join(workspace, 'approval-history.json');
  await copyFile(join(root, 'checks/approval-history.json'), suite);
  await writeFile(join(workspace, 'flowqa.config.json'), JSON.stringify({
    schemaVersion: 'flow-qa/config-1', targets: { returns: { url: origin } }, timeoutMs: 4000, retries: 0,
  }));
  const cli = join(root, 'node_modules/@ihyeon/flow-qa/dist/bin/flow-qa.mjs');
  const { stdout } = await promisify(execFile)(process.execPath,
    [cli, 'run', 'approval-history.json', '--workspace', workspace, '--target', 'returns'], { cwd: root, timeout: 90_000 });
  const reportPath = stdout.match(/^Raw result:\s*(.+)$/m)?.[1]?.trim();
  assert.ok(reportPath, stdout);
  const report = JSON.parse(await readFile(reportPath, 'utf8'));
  assert.equal(report.status, 'passed');
  await writeFile(join(workspace, 'proof.json'), JSON.stringify({
    browser: browser.version(), firstStatus: 200, secondStatus: 412, sameIfMatch: '"1"',
    draftRecoveredAfterReload: true, draftsIsolatedByReviewer: true, staleQueueReconciledAfterApproval: true,
    staleDetailReconciledAfterFreshQueue: true,
    lostResponseRetriedWithSameKey: true, lostResponseApprovalEntries: 1, sameReviewerConflictAttributedCorrectly: true,
    version: record.version, approvals: approvals.length, flowQaRun: report.runId,
  }, null, 2) + '\n');
  console.log(`Dual browser approvals: 200 / 412, one audit entry, local draft preserved.\n${stdout}\nEvidence: ${workspace}`);
} finally {
  await browser?.close();
  if (server.listening) await promisify(server.close).call(server);
}
