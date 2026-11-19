import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, firefox, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const browserName = process.env.RETURN_DEMO_BROWSER ?? 'chromium';
const browsers = { chromium, firefox, webkit };
const output = join(root, 'output', 'web-demo', browserName);
const recordId = 'RET-2418';
const winnerMemo = '첫 번째 담당자의 검수 기록';
const draftMemo = '두 번째 담당자의 보관할 초안';

async function startPreview() {
  await readFile(join(root, 'dist-demo', 'index.html'));
  const preview = spawn(process.execPath, [
    join(root, 'node_modules', 'vite', 'bin', 'vite.js'),
    'preview', '--host', '127.0.0.1', '--port', '0', '--outDir', 'dist-demo',
  ], { cwd: root, env: { ...process.env, FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });

  const origin = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error(`Vite preview did not start. ${output}`)), 15_000);
    function onChunk(chunk) {
      output += chunk.toString();
      const url = output.match(/http:\/\/127\.0\.0\.1:\d+\//)?.[0];
      if (!url) return;
      clearTimeout(timeout);
      resolve(new URL(url).origin);
    }
    preview.stdout.on('data', onChunk);
    preview.stderr.on('data', onChunk);
    preview.once('error', error => { clearTimeout(timeout); reject(error); });
    preview.once('exit', code => { clearTimeout(timeout); reject(new Error(`Vite preview exited ${code}. ${output}`)); });
  });
  return { origin, preview };
}

async function run() {
  const suppliedUrl = process.argv[2];
  let preview;
  let browser;
  try {
    const local = suppliedUrl ? null : await startPreview();
    preview = local?.preview;
    const origin = suppliedUrl ? new URL(suppliedUrl).origin : local.origin;
    assert.ok(origin.startsWith('https://') || origin.startsWith('http://127.0.0.1:'), 'Pass a public HTTPS URL or use the local Vite preview.');
    assert.ok(Object.hasOwn(browsers, browserName), 'RETURN_DEMO_BROWSER must be chromium, firefox, or webkit.');
    browser = await browsers[browserName].launch();
    const shared = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const isolated = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const apiRequests = [];
    for (const context of [shared, isolated]) {
      context.on('request', request => {
        if (new URL(request.url()).pathname.startsWith('/api/')) apiRequests.push(request.url());
      });
    }
    const first = await shared.newPage();
    const second = await shared.newPage();
    const otherBrowser = await isolated.newPage();
    for (const page of [first, second, otherBrowser]) page.setDefaultTimeout(10_000);
    const app = new URL(`/?id=${recordId}&lang=ko`, origin).href;

    assert.equal((await first.goto(app))?.status(), 200);
    await first.getByTestId('web-demo').waitFor();
    await first.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
    await first.getByTestId('reset-demo').click();
    await first.getByTestId('confirm-reset-demo').click();
    await first.getByTestId('record-status').getByText('검수 대기').waitFor();
    await second.goto(app);
    await second.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
    await second.getByRole('combobox', { name: '검수 담당자' }).selectOption('지훈');
    for (const page of [first, second]) {
      await page.getByRole('button', { name: '승인하기' }).click();
      await page.getByRole('dialog', { name: '반품 승인' }).waitFor();
    }
    await first.getByRole('textbox', { name: '검수 메모' }).fill(winnerMemo);
    await second.getByRole('textbox', { name: '검수 메모' }).fill(draftMemo);
    await first.getByRole('button', { name: '승인 확정' }).click();
    await first.getByRole('dialog', { name: '반품 승인' }).waitFor({ state: 'hidden' });
    await first.getByTestId('record-status').getByText('승인 완료').waitFor();
    await second.getByRole('button', { name: '승인 확정' }).click();
    await second.getByRole('alert').filter({ hasText: '다른 담당자가 먼저 처리했어요.' }).waitFor();
    assert.equal(await second.getByRole('textbox', { name: '검수 메모' }).inputValue(), draftMemo);
    await mkdir(output, { recursive: true });
    await second.screenshot({ path: join(output, 'conflict.png'), fullPage: true });

    await second.getByRole('button', { name: '닫고 내역 보기' }).click();
    await second.getByText(`보관된 검수 메모 ${draftMemo}`, { exact: true }).waitFor();
    await second.reload();
    await second.getByTestId('record-status').getByText('승인 완료').waitFor();
    await second.getByText(`보관된 검수 메모 ${draftMemo}`, { exact: true }).waitFor();
    assert.equal(await second.locator('.history li').filter({ hasText: '검수 승인' }).count(), 1);
    await second.locator('.history li').filter({ hasText: '검수 승인' }).getByText(winnerMemo).waitFor();

    await otherBrowser.goto(app);
    await otherBrowser.getByTestId('record-status').getByText('검수 대기').waitFor();
    await otherBrowser.getByTestId('web-demo').waitFor();
    await otherBrowser.getByRole('combobox', { name: '언어' }).selectOption('en');
    await otherBrowser.waitForFunction(() => document.documentElement.lang === 'en');
    await otherBrowser.getByRole('heading', { name: 'Washed Cotton Jacket' }).waitFor();
    await otherBrowser.getByTestId('record-status').getByText('Pending review').waitFor();
    await otherBrowser.getByTestId('reset-demo').waitFor();
    await otherBrowser.screenshot({ path: join(output, 'english.png'), fullPage: true });

    await first.getByTestId('reset-demo').click();
    await first.getByTestId('confirm-reset-demo').click();
    await first.getByTestId('record-status').getByText('검수 대기').waitFor();
    await second.getByTestId('record-status').getByText('검수 대기').waitFor();
    await second.getByRole('button', { name: '승인하기' }).click();
    assert.equal(await second.getByRole('textbox', { name: '검수 메모' }).inputValue(), '');
    await first.reload();
    await first.getByTestId('record-status').getByText('검수 대기').waitFor();
    assert.equal(await first.locator('.history li').filter({ hasText: '검수 승인' }).count(), 0);
    assert.deepEqual(apiRequests, [], 'Static demo must not call the local console API or error collector.');

    const evidence = {
      status: 'passed', origin, checkedAt: new Date().toISOString(),
      browser: browserName, languages: ['ko', 'en'],
      sameBrowserConflict: true, oneApprovalEvent: true, draftRecoveredAfterReload: true,
      isolatedBrowserState: true, resetSynchronizesTabs: true, apiRequests,
    };
    await writeFile(join(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Web demo passed at ${origin}. Evidence: ${output}`);
  } finally {
    await browser?.close();
    if (preview) preview.kill();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
