import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createReturnServer } from '../server/index.mjs';

const browser = await chromium.launch();

async function withServer(run) {
  const server = createReturnServer();
  server.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  try {
    await run(origin);
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

async function startDatabase(databasePath, port = 0) {
  const server = createReturnServer({ databasePath });
  server.listen(port, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

async function stopDatabase(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}

async function detail(origin, id) {
  const response = await fetch(origin + '/api/returns/' + id);
  assert.equal(response.status, 200);
  return { etag: response.headers.get('etag'), record: (await response.json()).record };
}

async function decide(origin, id, command, reviewer, memo) {
  const current = await detail(origin, id);
  const response = await fetch(origin + '/api/returns/' + id + '/' + command, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': current.etag,
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ reviewer, memo }),
  });
  assert.equal(response.status, 200);
  return response;
}

async function pageAt(origin, id) {
  const page = await browser.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(origin + '/?id=' + id);
  await page.getByTestId('record-status').waitFor();
  return page;
}

try {
  await withServer(async origin => {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    let holdRequests = 0;
    await page.route('**/RET-2418/hold', async route => {
      holdRequests += 1;
      if (holdRequests === 1) {
        const committed = await route.fetch();
        assert.equal(committed.status(), 200);
        await route.abort('failed');
      } else {
        await route.continue();
      }
    });
    await page.goto(origin + '/?id=RET-2418');
    await page.getByRole('button', { name: '보류하기' }).click();
    await page.getByRole('textbox', { name: '결정 사유' }).fill('실물 재확인');
    await page.getByRole('button', { name: '보류 확정' }).click();
    await page.getByRole('alert').getByText('결정 결과를 확인하지 못했어요.', { exact: false }).waitFor();
    await decide(origin, 'RET-2418', 'reapprove', '지훈', '재검수 완료');
    await page.getByRole('button', { name: '같은 요청 재시도' }).click();
    await page.getByTestId('record-status').getByText('승인 완료').waitFor();
    assert.equal(await page.getByRole('button', { name: '재검수 승인' }).count(), 0);
    assert.equal(holdRequests, 2);
    const latest = await detail(origin, 'RET-2418');
    assert.equal(latest.record.events.filter(event => event.label === '검수 보류').length, 1);
    await page.close();
  });

  await withServer(async origin => {
    const page = await browser.newPage();
    page.setDefaultTimeout(8_000);
    let releaseQueue;
    const queueGate = new Promise(resolve => { releaseQueue = resolve; });
    await page.route(url => new URL(url).pathname === '/api/returns', async route => {
      await queueGate;
      const response = await route.fetch();
      await route.fulfill({ response });
    });
    await page.goto(origin + '/?id=RET-2421', { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '클래식 레더 토트' }).waitFor();
    await decide(origin, 'RET-2421', 'hold', '지훈', '실물 확인 필요');
    releaseQueue();
    await page.getByTestId('row-RET-2421').getByText('재검수 대기').waitFor();
    await page.getByTestId('record-status').getByText('재검수 대기').waitFor();
    assert.equal(await page.getByRole('button', { name: '승인하기' }).count(), 0);
    await page.close();
  });

  await withServer(async origin => {
    await decide(origin, 'RET-2423', 'hold', '민서', '보류');
    const page = await pageAt(origin, 'RET-2423');
    await page.getByRole('button', { name: '반려하기' }).click();
    await page.getByRole('textbox', { name: '결정 사유' }).fill('구성품 부족 메모');
    await decide(origin, 'RET-2423', 'reapprove', '민서', '재검수 완료');
    await page.getByRole('button', { name: '반려 확정' }).click();
    await page.getByRole('alert').getByText('같은 담당자의 다른 요청이 먼저 반영됐어요.', { exact: false }).waitFor();
    await page.getByRole('button', { name: '닫고 내역 보기' }).click();
    await page.getByTestId('record-status').getByText('승인 완료').waitFor();
    await page.locator('.draft-note').filter({ hasText: '구성품 부족 메모' }).waitFor();
    await page.reload();
    await page.getByTestId('record-status').getByText('승인 완료').waitFor();
    await page.locator('.draft-note').filter({ hasText: '구성품 부족 메모' }).waitFor();

    await decide(origin, 'RET-2429', 'hold', '민서', '보류');
    await page.goto(origin + '/?id=RET-2429');
    await page.getByTestId('record-status').getByText('재검수 대기').waitFor();
    await page.getByRole('button', { name: '재검수 승인' }).click();
    await decide(origin, 'RET-2429', 'reject', '지훈', '반려');
    await page.getByRole('button', { name: '승인 확정' }).click();
    await page.getByRole('alert').getByText('다른 담당자가 먼저 처리했어요.', { exact: false }).waitFor();
    await page.close();
  });

  const directory = await mkdtemp(join(tmpdir(), 'return-workspace-browser-'));
  let running;
  let page;
  try {
    running = await startDatabase(join(directory, 'first.sqlite'));
    const origin = running.origin;
    const port = Number(new URL(origin).port);
    page = await pageAt(origin, 'RET-2421');
    await page.getByRole('button', { name: '승인하기' }).click();
    await page.getByRole('textbox', { name: '검수 메모' }).fill('첫 폴더의 미전송 초안');
    await page.getByRole('button', { name: '취소' }).click();
    await page.evaluate(() => sessionStorage.setItem('return-review:draft:RET-2421:민서', '이전 버전의 출처 불명 메모'));
    await page.route('**/RET-2418/approve', async route => {
      const committed = await route.fetch();
      assert.equal(committed.status(), 200);
      await route.abort('failed');
    });
    await page.goto(origin + '/?id=RET-2418');
    await page.getByRole('button', { name: '승인하기' }).click();
    await page.getByRole('textbox', { name: '검수 메모' }).fill('첫 폴더의 대기 메모');
    await page.getByRole('button', { name: '승인 확정' }).click();
    await page.getByRole('alert').getByText('승인 결과를 확인하지 못했어요.', { exact: false }).waitFor();

    await stopDatabase(running.server);
    running = await startDatabase(join(directory, 'second.sqlite'), port);
    await page.reload();
    await page.getByTestId('record-status').getByText('검수 대기').waitFor();
    assert.equal(await page.getByRole('button', { name: '승인 결과 확인' }).count(), 0);
    await page.goto(origin + '/?id=RET-2421');
    await page.locator('.legacy-notes').getByText('이전 버전의 출처 불명 메모', { exact: false }).waitFor();
    await page.getByRole('button', { name: '승인하기' }).click();
    assert.equal(await page.getByRole('textbox', { name: '검수 메모' }).inputValue(), '');

    await stopDatabase(running.server);
    running = await startDatabase(join(directory, 'first.sqlite'), port);
    await page.goto(origin + '/?id=RET-2418');
    await page.getByTestId('record-status').getByText('승인 완료').waitFor();
    await page.getByRole('button', { name: '승인 결과 확인' }).click();
    assert.equal(await page.getByRole('textbox', { name: '검수 메모' }).inputValue(), '첫 폴더의 대기 메모');
    await page.goto(origin + '/?id=RET-2421');
    await page.getByRole('button', { name: '승인하기' }).click();
    assert.equal(await page.getByRole('textbox', { name: '검수 메모' }).inputValue(), '첫 폴더의 미전송 초안');
  } finally {
    await page?.close();
    if (running?.server.listening) await stopDatabase(running.server);
    await rm(directory, { recursive: true, force: true });
  }
  console.log('Workspace isolation, replay reconciliation, delayed queue/detail, saved decision draft, and reviewer attribution passed.');
} finally {
  await browser.close();
}
