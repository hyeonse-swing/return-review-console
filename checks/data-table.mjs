import assert from 'node:assert/strict';
import { chromium, firefox, webkit } from 'playwright';
import { createReturnServer } from '../server/index.mjs';

async function seedHeld(origin, id) {
  const detail = await fetch(`${origin}/api/returns/${id}`);
  assert.equal(detail.status, 200);
  const result = await fetch(`${origin}/api/returns/${id}/hold`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'If-Match': detail.headers.get('etag'),
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify({ reviewer: '민서', memo: `${id}의 긴 재검수 사유 · 실물의 포장과 표면 상태를 확인합니다.` }),
  });
  assert.equal(result.status, 200);
}

async function run(browserType) {
  const server = createReturnServer();
  let browser;
  try {
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    for (const id of ['RET-2418', 'RET-2421', 'RET-2423']) await seedHeld(origin, id);
    browser = await browserType.launch();
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.setDefaultTimeout(9_000);
    await page.goto(`${origin}/?id=RET-2429&lang=ko`);
    await page.getByRole('heading', { name: '오버사이즈 스트라이프 셔츠' }).waitFor();

    const region = page.locator('.held-review .hds-tableScroll');
    const table = region.getByRole('table', { name: '보류 재검수 목록' });
    const firstPage = await table.locator('tbody tr').allTextContents();
    assert.equal(firstPage.length, 2);
    assert.match(firstPage[0], /RET-2418/);
    assert.match(firstPage[1], /RET-2421/);
    assert.equal(await table.getByRole('columnheader', { name: /입고 시각/ }).getAttribute('aria-sort'), 'ascending');

    await table.getByRole('checkbox', { name: /RET-2418/ }).check();
    assert.match(await page.locator('.detail-kicker').innerText(), /RET-2429/);
    await page.getByRole('navigation', { name: '보류 재검수 목록 · 페이지 이동' }).getByRole('button', { name: '페이지 2' }).click();
    assert.match((await table.locator('tbody tr').first().innerText()), /RET-2423/);
    assert.match(await page.getByRole('status').filter({ hasText: '선택한 행이 현재 페이지에 없습니다.' }).innerText(), /선택한 행이 현재 페이지에 없습니다/);
    await page.waitForFunction(() => document.activeElement?.classList.contains('hds-tableScroll'));
    await table.getByRole('button', { name: '상세 열기' }).click();
    await page.getByRole('heading', { name: '리브 니트 카디건' }).waitFor();
    assert.match(await page.getByRole('status').filter({ hasText: '선택한 행이 현재 페이지에 없습니다.' }).innerText(), /선택한 행이 현재 페이지에 없습니다/);

    await table.getByRole('button', { name: '입고 시각: 내림차순 정렬' }).focus();
    await page.keyboard.press('Enter');
    assert.equal(await table.getByRole('columnheader', { name: /입고 시각/ }).getAttribute('aria-sort'), 'descending');
    assert.match((await table.locator('tbody tr').first().innerText()), /RET-2423/);
    await table.getByRole('button', { name: '입고 시각: 오름차순 정렬' }).focus();
    await page.keyboard.press('Space');
    assert.equal(await table.getByRole('columnheader', { name: /입고 시각/ }).getAttribute('aria-sort'), 'ascending');
    assert.match((await table.locator('tbody tr').first().innerText()), /RET-2418/);

    const selectedDetail = await fetch(`${origin}/api/returns/RET-2418`);
    const updated = await fetch(`${origin}/api/returns/RET-2418/reapprove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'If-Match': selectedDetail.headers.get('etag') },
      body: JSON.stringify({ reviewer: '지훈', memo: '재검수 완료' }),
    });
    assert.equal(updated.status, 200);
    await page.getByRole('button', { name: '새로고침' }).click();
    await page.locator('.held-review').getByRole('status').filter({ hasText: '전체 2건 중 1–2건' }).waitFor();
    await table.getByRole('row').filter({ hasText: 'RET-2418' }).waitFor({ state: 'hidden' });
    assert.equal(await table.getByRole('checkbox', { checked: true }).count(), 0);

    await page.getByRole('combobox', { name: '언어' }).selectOption('en');
    await page.getByRole('table', { name: 'Returns awaiting reinspection' }).waitFor();

    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(`${origin}/?lang=ko`);
    const mobileTable = mobile.locator('.held-review .hds-tableScroll');
    await mobileTable.waitFor({ state: 'visible' });
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await mobileTable.evaluate(element => element.scrollWidth > element.clientWidth), true);
    console.log(`${browserType.name()}: Return Desk held DataTable consumer passed.`);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}

for (const browserType of [chromium, firefox, webkit]) await run(browserType);
