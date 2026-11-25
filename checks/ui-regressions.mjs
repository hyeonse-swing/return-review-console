import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { createReturnServer } from '../server/index.mjs';

const server = createReturnServer();
let browser;

try {
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();

  async function change(id, command, reviewer) {
    const detail = await fetch(`${origin}/api/returns/${id}`);
    assert.equal(detail.status, 200);
    const response = await fetch(`${origin}/api/returns/${id}/${command}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'If-Match': detail.headers.get('etag'),
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify({ reviewer, memo: command === 'hold' ? '실물 재검수 필요' : '' }),
    });
    assert.equal(response.status, 200);
  }

  await change('RET-2418', 'hold', '지훈');
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.setDefaultTimeout(8_000);
  let releaseAssignment;
  let captureAssignment;
  const assignmentCaptured = new Promise(resolve => { captureAssignment = resolve; });
  const assignmentReleased = new Promise(resolve => { releaseAssignment = resolve; });
  await page.route('**/RET-2418/assign', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    captureAssignment();
    await assignmentReleased;
    await route.fulfill({ response });
  });
  await page.goto(`${origin}/?id=RET-2418`);
  await page.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
  await page.getByRole('button', { name: '내가 맡기', exact: true }).click();
  await assignmentCaptured;
  await page.getByTestId('row-RET-2421').click();
  await page.getByRole('heading', { name: '클래식 레더 토트' }).waitFor();
  releaseAssignment();
  await page.getByTestId('row-RET-2418').getByText('민서').waitFor();
  assert.equal(await page.getByRole('heading', { name: '클래식 레더 토트' }).count(), 1);
  assert.equal(new URL(page.url()).searchParams.get('id'), 'RET-2421');

  await change('RET-2423', 'hold', '지훈');
  let releaseStale;
  let captureStale;
  const staleCaptured = new Promise(resolve => { captureStale = resolve; });
  const staleReleased = new Promise(resolve => { releaseStale = resolve; });
  await page.route('**/RET-2423/assign', async route => {
    await change('RET-2423', 'assign', '지훈');
    const response = await route.fetch();
    assert.equal(response.status(), 412);
    captureStale();
    await staleReleased;
    await route.fulfill({ response });
  });
  await page.goto(`${origin}/?id=RET-2423`);
  await page.getByRole('heading', { name: '리브 니트 카디건' }).waitFor();
  await page.getByRole('button', { name: '내가 맡기', exact: true }).click();
  await staleCaptured;
  await page.getByTestId('row-RET-2421').click();
  await page.getByRole('heading', { name: '클래식 레더 토트' }).waitFor();
  releaseStale();
  await page.getByTestId('row-RET-2423').getByText('지훈').waitFor();
  assert.equal(await page.getByRole('heading', { name: '클래식 레더 토트' }).count(), 1);

  await change('RET-2426', 'hold', '지훈');
  let releaseRefresh;
  let captureRefresh;
  const refreshCaptured = new Promise(resolve => { captureRefresh = resolve; });
  const refreshReleased = new Promise(resolve => { releaseRefresh = resolve; });
  await page.route('**/RET-2426/assign', async route => {
    const response = await route.fetch();
    assert.equal(response.status(), 200);
    captureRefresh();
    await refreshReleased;
    await route.fulfill({ response });
  });
  await page.goto(`${origin}/?id=RET-2426`);
  await page.getByRole('heading', { name: '캔버스 로우 스니커즈' }).waitFor();
  await page.getByRole('button', { name: '내가 맡기', exact: true }).click();
  await refreshCaptured;
  await page.getByRole('button', { name: '새로고침' }).click();
  await page.getByRole('heading', { name: '캔버스 로우 스니커즈' }).waitFor();
  releaseRefresh();
  await page.locator('.assignment').getByText('민서').waitFor();
  assert.equal(await page.getByRole('heading', { name: '캔버스 로우 스니커즈' }).count(), 1);

  await page.goto(`${origin}/?id=RET-2429`);
  await page.getByRole('heading', { name: '오버사이즈 스트라이프 셔츠' }).waitFor();
  await page.getByRole('button', { name: '승인하기' }).click();
  await change('RET-2429', 'hold', '지훈');
  await page.getByRole('button', { name: '승인 확정' }).click();
  await page.getByRole('alert').getByText('다른 담당자가 먼저 처리했어요.', { exact: false }).waitFor();
  await page.getByRole('button', { name: '닫고 내역 보기' }).click();
  await page.getByTestId('record-status').getByText('재검수 대기').waitFor();
  assert.match(await page.locator('.approval-bar').innerText(), /이 반품의 상태가 변경됐어요/);
  assert.doesNotMatch(await page.locator('.approval-bar').innerText(), /승인 기록을 확인/);
  assert.equal(await page.getByRole('button', { name: '승인하기' }).count(), 0);

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  mobile.setDefaultTimeout(8_000);
  await mobile.goto(`${origin}/?id=RET-2421`);
  await mobile.getByRole('heading', { name: '클래식 레더 토트' }).waitFor();
  await mobile.getByRole('button', { name: '반품 목록', exact: true }).click();
  await mobile.waitForFunction(() => document.activeElement?.textContent?.includes('RET-2421'));
  assert.equal(new URL(mobile.url()).searchParams.get('id'), null);
  await mobile.reload();
  await mobile.getByTestId('row-RET-2421').waitFor();
  assert.equal(await mobile.locator('.queue').isVisible(), true);
  assert.equal(await mobile.locator('.detail').isVisible(), false);
  console.log('Delayed assignment, stale conflict, refresh, approval status, and mobile list regressions passed.');
} finally {
  await browser?.close();
  if (server.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
