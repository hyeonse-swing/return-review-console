import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';
import { createReturnServer } from '../server/index.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixtures = JSON.parse(await readFile(new URL('../shared/fixtures.json', import.meta.url)));

async function openDemoPreview() {
  const process = spawn('node', ['node_modules/vite/bin/vite.js', 'preview', '--host', '127.0.0.1', '--port', '0', '--outDir', 'dist-demo'], {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const origin = await new Promise((resolve, reject) => {
    let logs = '';
    const timer = setTimeout(() => reject(new Error('Demo preview did not start.')), 15_000);
    const output = chunk => {
      logs += chunk.toString();
      const match = logs.match(/http:\/\/127\.0\.0\.1:\d+\//);
      if (match) { clearTimeout(timer); resolve(new URL(match[0]).origin); }
    };
    process.stdout.on('data', output);
    process.stderr.on('data', output);
    process.once('error', reject);
    process.once('exit', code => reject(new Error(`Demo preview exited ${code}: ${logs}`)));
  });
  return { origin, process };
}

async function choose(page, id) {
  await page.getByTestId(`row-${id}`).click();
}

async function act(page, action, title, reason) {
  await page.getByRole('button', { name: action, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: title });
  await dialog.waitFor();
  if (reason !== undefined) await dialog.getByRole('textbox', { name: '결정 사유' }).fill(reason);
  return dialog;
}

async function run(browserType) {
  const browser = await browserType.launch();
  const server = createReturnServer();
  let demo;
  try {
    server.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const serverOrigin = `http://127.0.0.1:${server.address().port}`;
    const local = await browser.newPage();
    local.setDefaultTimeout(9_000);
    await local.goto(`${serverOrigin}/?id=RET-2418`);
    await local.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
    const hold = await act(local, '보류하기', '반품 보류', '');
    assert.equal(await hold.getByRole('button', { name: '보류 확정' }).isDisabled(), true);
    await hold.getByRole('textbox', { name: '결정 사유' }).fill('상태 재확인 필요');
    await hold.getByRole('button', { name: '보류 확정' }).click();
    await local.getByTestId('record-status').getByText('재검수 대기').waitFor();
    assert.match(await local.getByTestId('row-RET-2418').innerText(), /상태 재확인 필요/);
    await local.reload();
    await local.getByTestId('record-status').getByText('재검수 대기').waitFor();
    await local.getByRole('combobox', { name: '검수 담당자' }).selectOption('지훈');
    const reject = await act(local, '반려하기', '재검수 반려', '실물 상태 불량');
    await reject.getByRole('button', { name: '반려 확정' }).click();
    await local.getByTestId('record-status').getByText('반려 완료').waitFor();
    assert.match(await local.locator('.history').innerText(), /검수 보류[\s\S]*실물 상태 불량|실물 상태 불량[\s\S]*검수 보류/);
    await local.reload();
    await local.getByTestId('record-status').getByText('반려 완료').waitFor();

    demo = await openDemoPreview();
    const context = await browser.newContext();
    const first = await context.newPage();
    first.setDefaultTimeout(9_000);
    await first.route('**/seed', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Seed</title>' }));
    await first.goto(`${demo.origin}/seed`);
    await first.unroute('**/seed');
    await first.evaluate(records => new Promise((resolve, reject) => {
      const request = indexedDB.open('return-review-console-web-demo-v1', 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const rows = db.createObjectStore('records', { keyPath: 'id' });
        db.createObjectStore('receipts', { keyPath: 'key' });
        db.createObjectStore('metadata').put(crypto.randomUUID(), 'generation');
        records.forEach(row => rows.add(row));
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => { request.result.close(); resolve(); };
    }), fixtures);
    await first.goto(`${demo.origin}/?id=RET-2411`);
    await first.getByTestId('record-status').getByText('승인 완료').waitFor();
    await first.getByTestId('row-RET-2411').getByText('승인 완료').waitFor();
    await choose(first, 'RET-2421');
    const held = await act(first, '보류하기', '반품 보류', '포장 확인 필요');
    await held.getByRole('button', { name: '보류 확정' }).click();
    await first.getByTestId('record-status').getByText('재검수 대기').waitFor();

    const second = await context.newPage();
    second.setDefaultTimeout(9_000);
    await second.goto(`${demo.origin}/?id=RET-2421`);
    await second.getByTestId('record-status').getByText('재검수 대기').waitFor();
    const rejectOther = await act(second, '반려하기', '재검수 반려', '다른 담당자의 반려 사유');
    const approveFirst = await act(first, '재검수 승인', '재검수 승인');
    await approveFirst.getByRole('button', { name: '승인 확정' }).click();
    await first.getByTestId('record-status').getByText('승인 완료').waitFor();
    await rejectOther.getByRole('button', { name: '반려 확정' }).click();
    await second.getByRole('alert').filter({ hasText: '다른 담당자가 먼저 처리했어요.' }).waitFor();
    assert.match(await rejectOther.getByRole('textbox', { name: '결정 사유' }).inputValue(), /다른 담당자의 반려 사유/);
    await second.reload();
    await second.getByTestId('record-status').getByText('승인 완료').waitFor();
    assert.equal(await second.getByTestId('record-status').getByText('승인 완료').count(), 1);
    assert.match(await second.locator('.history').innerText(), /검수 보류[\s\S]*재검수 승인|재검수 승인[\s\S]*검수 보류/);

    console.log(`${browserType.name()}: reinspection server and upgraded browser demo passed.`);
  } finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (demo) demo.process.kill();
  }
}

for (const browserType of [chromium, firefox, webkit]) await run(browserType);
