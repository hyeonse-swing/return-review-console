import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chromium, firefox, webkit } from 'playwright';

const root = fileURLToPath(new URL('../', import.meta.url));
const runFile = promisify(execFile);
const browserTypes = { chromium, firefox, webkit };
const packageName = '@ihyeon/return-review-console';
const projectUrl = 'https://www.npmjs.com/package/@ihyeon/return-review-console';
const binName = 'return-review-console';
const recordId = 'RET-2418';
const recordPath = `/api/returns/${recordId}`;

function requireStatus(response, status, description) {
  assert.equal(response.status, status, `${description}: expected HTTP ${status}, received ${response.status}`);
  return response;
}

async function packageFingerprint(directory) {
  const entries = [];
  async function visit(directoryPath) {
    for (const entry of await readdir(directoryPath, { withFileTypes: true })) {
      const path = join(directoryPath, entry.name);
      const name = relative(directory, path);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const contents = await readFile(path);
        entries.push(`${name}\0${contents.length}\0${createHash('sha256').update(contents).digest('hex')}`);
      } else if (entry.isSymbolicLink()) {
        entries.push(`${name}\0link\0${await readlink(path)}`);
      } else {
        throw new Error(`Unexpected package entry: ${name}`);
      }
    }
  }
  await visit(directory);
  return createHash('sha256').update(entries.sort().join('\n')).digest('hex');
}

async function runCli(bin, args, cwd) {
  const { stdout, stderr } = await runFile(bin, args, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
  return `${stdout}${stderr}`.trim();
}

async function startCli(bin, cwd, dataDir, language) {
  await mkdir(dataDir, { recursive: true });
  const args = ['--data-dir', dataDir, '--port', '0'];
  if (language) args.push('--lang', language);
  const child = spawn(bin, args, {
    cwd,
    env: { ...process.env, RETURN_QA: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-2048); });
  const advertisedUrl = await new Promise((resolveUrl, reject) => {
    let stdout = '';
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolveUrl(value);
    }
    const timer = setTimeout(() => finish(new Error(`CLI did not print its origin within 15 seconds. ${stderr}`)), 15_000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout = `${stdout}${chunk}`.slice(-4096);
      const match = stdout.match(/http:\/\/127\.0\.0\.1:\d+\S*(?=\r?\n)/);
      if (match) finish(null, match[0]);
    });
    child.once('error', error => finish(error));
    child.once('exit', (code, signal) => finish(new Error(`CLI exited before ready (${code ?? signal}). ${stderr}`)));
  }).catch(async error => {
    await stopCli(child);
    throw error;
  });
  return { child, origin: new URL(advertisedUrl).origin, advertisedUrl };
}

async function stopCli(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveExit => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolveExit();
    });
    child.kill('SIGTERM');
  });
}

async function killCli(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise(resolveExit => {
    child.once('exit', resolveExit);
    child.kill('SIGKILL');
  });
}

async function detail(origin, id = recordId) {
  const response = requireStatus(await fetch(`${origin}/api/returns/${id}`), 200, 'record detail');
  const etag = response.headers.get('etag');
  assert.match(etag ?? '', /^"[1-9]\d*"$/, 'record detail needs an ETag');
  const { record } = await response.json();
  assert.equal(record.id, id);
  return { record, etag };
}

async function approve(origin, etag, key, reviewer, memo) {
  return fetch(`${origin}${recordPath}/approve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'If-Match': etag, 'Idempotency-Key': key },
    body: JSON.stringify({ reviewer, memo }),
  });
}

function approvalEvents(record) {
  return record.events.filter(event => event.label === '검수 승인');
}

async function checkRestartAndConcurrency(bin, cwd, workspace) {
  const dataDir = join(workspace, 'restart-data');
  const key = randomUUID();
  const reviewer = '민서';
  const memo = '설치 패키지 검수 확인';
  let running = await startCli(bin, cwd, dataDir);
  let firstBody;
  let firstEtag;
  let initialEtag;
  let killed = false;
  try {
    requireStatus(await fetch(`${running.origin}/__qa/events`), 404, 'QA events must be hidden');
    requireStatus(await fetch(`${running.origin}/__qa/fault`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ on: true }),
    }), 404, 'QA fault switch must be hidden');

    const initial = await detail(running.origin);
    initialEtag = initial.etag;
    assert.equal(initial.record.status, 'pending');
    const first = requireStatus(await approve(running.origin, initial.etag, key, reviewer, memo), 200, 'first approval');
    firstEtag = first.headers.get('etag');
    firstBody = await first.text();
    const firstRecord = JSON.parse(firstBody).record;
    assert.equal(firstRecord.status, 'approved');
    assert.equal(firstRecord.version, initial.record.version + 1);
    assert.equal(approvalEvents(firstRecord).length, 1);
    await killCli(running.child);
    killed = true;
  } finally {
    if (!killed) await stopCli(running.child);
  }

  assert.ok((await stat(join(dataDir, 'console.sqlite'))).isFile(), 'database must be inside --data-dir');
  running = await startCli(bin, cwd, dataDir);
  try {
    const restored = await detail(running.origin);
    assert.equal(restored.record.status, 'approved');
    assert.equal(restored.record.version, 2);
    assert.equal(approvalEvents(restored.record).length, 1);
    assert.equal(approvalEvents(restored.record)[0].memo, memo);
    const stale = requireStatus(await approve(running.origin, initialEtag, randomUUID(), '지훈', '오래된 화면'), 412, 'stale approval after restart');
    const staleBody = await stale.json();
    assert.equal(staleBody.code, 'STALE_VERSION');
    assert.equal(staleBody.record.status, 'approved');
    const queue = requireStatus(await fetch(`${running.origin}/api/returns`), 200, 'restored queue');
    const queueRecord = (await queue.json()).records.find(record => record.id === recordId);
    assert.equal(queueRecord.status, 'approved');

    const replay = requireStatus(await approve(running.origin, '"1"', key, reviewer, memo), 200, 'idempotency replay after restart');
    assert.equal(replay.headers.get('etag'), firstEtag);
    assert.equal(await replay.text(), firstBody, 'replayed approval body must be identical');
    const afterReplay = await detail(running.origin);
    assert.equal(approvalEvents(afterReplay.record).length, 1);
    requireStatus(await fetch(`${running.origin}/__qa/events`), 404, 'QA events after restart');
    return {
      firstApproval: 200,
      staleApproval: 412,
      persistedStatus: restored.record.status,
      persistedVersion: restored.record.version,
      approvalEvents: approvalEvents(afterReplay.record).length,
      replayAfterProcessRestart: 200,
      replayBodyAndEtagIdentical: true,
      firstProcessStoppedWith: 'SIGKILL',
      qaEvents: 404,
      qaFault: 404,
      databaseInsideDataDir: true,
    };
  } finally {
    await stopCli(running.child);
  }
}

async function checkCrossProcessConcurrency(bin, cwd, workspace) {
  const dataDir = join(workspace, 'concurrent-process-data');
  const first = await startCli(bin, cwd, dataDir);
  let second;
  try {
    second = await startCli(bin, cwd, dataDir);
    const [firstInitial, secondInitial] = await Promise.all([detail(first.origin), detail(second.origin)]);
    assert.equal(firstInitial.record.status, 'pending');
    assert.equal(secondInitial.record.status, 'pending');
    assert.equal(firstInitial.etag, secondInitial.etag);

    const responses = await Promise.all([
      approve(first.origin, firstInitial.etag, randomUUID(), '민서', '첫 번째 프로세스'),
      approve(second.origin, secondInitial.etag, randomUUID(), '지훈', '두 번째 프로세스'),
    ]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 412], 'two processes must commit one approval');
    const bodies = await Promise.all(responses.map(response => response.json()));
    assert.equal(bodies.find((_, index) => responses[index].status === 412).code, 'STALE_VERSION');
    const [firstAfter, secondAfter] = await Promise.all([detail(first.origin), detail(second.origin)]);
    assert.deepEqual(firstAfter.record, secondAfter.record, 'both processes must read the same committed history');
    assert.equal(firstAfter.record.status, 'approved');
    assert.equal(firstAfter.record.version, 2);
    assert.equal(approvalEvents(firstAfter.record).length, 1);
    return {
      cliProcesses: 2,
      responseStatuses: [200, 412],
      recordVersion: firstAfter.record.version,
      approvalEvents: approvalEvents(firstAfter.record).length,
      sameHistoryFromBothProcesses: true,
    };
  } finally {
    await Promise.all([stopCli(first.child), second && stopCli(second.child)]);
  }
}

async function checkBrowser(name, browserType, bin, cwd, workspace, outputDir) {
  const executable = browserType.executablePath();
  try {
    await stat(executable);
  } catch (error) {
    if (error.code === 'ENOENT') return { browser: name, status: 'unavailable', reason: 'Playwright browser executable is not installed' };
    throw error;
  }

  const running = await startCli(bin, cwd, join(workspace, `${name}-data`));
  let browser;
  try {
    browser = await browserType.launch();
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 }, locale: 'ko-KR' });
    page.setDefaultTimeout(10_000);
    await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: text => { window.__copiedHistory = text; return Promise.resolve(); } },
    }));
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    const initial = await detail(running.origin);
    assert.equal(initial.record.status, 'pending', `${name} must have an independent data directory`);
    assert.equal((await page.goto(`${running.origin}/?id=${recordId}`)).status(), 200, `${name} app page`);
    assert.equal(await page.locator('html').getAttribute('lang'), 'ko', `${name} default document language`);
    await page.getByRole('heading', { name: '워시드 코튼 재킷' }).waitFor();
    await page.getByRole('button', { name: '승인하기' }).click();
    await page.getByRole('dialog', { name: '반품 승인' }).waitFor();
    const memo = `${name} 화면 검수`;
    await page.getByRole('textbox', { name: '검수 메모' }).fill(memo);
    const approvalResponse = page.waitForResponse(response =>
      new URL(response.url()).pathname === `${recordPath}/approve` && response.request().method() === 'POST');
    await page.getByRole('button', { name: '승인 확정' }).click();
    assert.equal((await approvalResponse).status(), 200, `${name} UI approval`);
    await page.getByTestId('record-status').getByText('승인 완료').waitFor();
    const persisted = await detail(running.origin);
    assert.equal(persisted.record.status, 'approved');
    assert.equal(approvalEvents(persisted.record).length, 1);
    assert.equal(approvalEvents(persisted.record)[0].memo, memo);
    await page.getByRole('button', { name: '처리 내역 복사' }).click();
    await page.getByRole('status').getByText('처리 내역을 복사했어요.').waitFor();
    const copiedHistory = await page.evaluate(() => window.__copiedHistory);
    assert.match(copiedHistory, /^반품 번호: RET-2418\n검수 상태: 승인 완료\n처리 내역:/);
    assert.match(copiedHistory, new RegExp(`검수 승인 · 민서\\n${memo}`));
    assert.deepEqual(pageErrors, [], `${name} page errors`);
    const screenshot = `${name}-approved.png`;
    await page.screenshot({ path: join(outputDir, screenshot), fullPage: true });

    await page.getByRole('combobox', { name: '언어' }).selectOption('en');
    await page.waitForURL(url => url.searchParams.get('lang') === 'en');
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    assert.equal(await page.evaluate(() => localStorage.getItem('return-review:language')), 'en', `${name} stored language preference`);
    await page.getByRole('heading', { name: 'Washed Cotton Jacket' }).waitFor();
    await page.getByTestId('record-status').getByText('Approved').waitFor();
    await page.getByRole('button', { name: 'Copy activity history' }).click();
    const copiedEnglishHistory = await page.evaluate(() => window.__copiedHistory);
    assert.match(copiedEnglishHistory, /^Return ID: RET-2418\nReview status: Approved\nActivity history:/);
    assert.match(copiedEnglishHistory, new RegExp(`Review approved · Minseo\\n${memo}`));
    assert.equal((await page.goto(`${running.origin}/?id=${recordId}`)).status(), 200, `${name} language persistence page`);
    await page.waitForFunction(() => document.documentElement.lang === 'en');
    await page.getByRole('heading', { name: 'Washed Cotton Jacket' }).waitFor();

    const englishPage = await browser.newPage({ viewport: { width: 1360, height: 900 }, locale: 'en-US' });
    englishPage.setDefaultTimeout(10_000);
    englishPage.on('pageerror', error => pageErrors.push(error.message));
    const englishId = 'RET-2429';
    assert.equal((await englishPage.goto(`${running.origin}/?id=${englishId}&lang=en`)).status(), 200, `${name} English app page`);
    await englishPage.waitForFunction(() => document.documentElement.lang === 'en');
    await englishPage.getByRole('heading', { name: 'Oversized Stripe Shirt' }).waitFor();
    await englishPage.getByRole('button', { name: 'Approve return' }).click();
    await englishPage.getByRole('dialog', { name: 'Approve return' }).waitFor();
    const englishMemo = `${name} English review`;
    await englishPage.getByRole('textbox', { name: 'Review memo' }).fill(englishMemo);
    const englishApprovalResponse = englishPage.waitForResponse(response =>
      new URL(response.url()).pathname === `/api/returns/${englishId}/approve` && response.request().method() === 'POST');
    await englishPage.getByRole('button', { name: 'Confirm approval' }).click();
    assert.equal((await englishApprovalResponse).status(), 200, `${name} English UI approval`);
    await englishPage.getByTestId('record-status').getByText('Approved').waitFor();
    const englishPersisted = await detail(running.origin, englishId);
    assert.equal(englishPersisted.record.status, 'approved');
    assert.equal(approvalEvents(englishPersisted.record).length, 1);
    assert.equal(approvalEvents(englishPersisted.record)[0].memo, englishMemo);
    assert.deepEqual(pageErrors, [], `${name} page errors`);
    const englishScreenshot = `${name}-approved-en.png`;
    await englishPage.screenshot({ path: join(outputDir, englishScreenshot), fullPage: true });
    return {
      browser: name,
      status: 'passed',
      version: browser.version(),
      defaultLanguage: 'ko',
      accessibleDialogName: '반품 승인',
      accessibleMemoName: '검수 메모',
      approvalHttp: 200,
      approvalEvents: 1,
      historyCopiedInBothLanguages: true,
      englishLanguageFromUrl: 'en',
      switchedLanguagePersisted: true,
      englishAccessibleDialogName: 'Approve return',
      englishAccessibleMemoName: 'Review memo',
      englishApprovalHttp: 200,
      englishApprovalEvents: 1,
      pageErrors: 0,
      screenshot,
      englishScreenshot,
    };
  } finally {
    await browser?.close();
    await stopCli(running.child);
  }
}

async function main() {
  const input = process.argv[2];
  if (!input) throw new Error('Usage: node checks/package-consumer.mjs <package.tgz|@ihyeon/return-review-console@exact-version> [evidence-directory]');
  const isTarball = input.endsWith('.tgz');
  if (!isTarball && !/^@ihyeon\/return-review-console@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(input)) {
    throw new Error('Registry input must specify one exact @ihyeon/return-review-console version.');
  }
  const spec = isTarball ? resolve(input) : input;
  if (isTarball) assert.ok((await stat(spec)).isFile(), 'tarball does not exist');
  const outputDir = resolve(process.argv[3] ?? join(root, 'output', 'package-consumer', new Date().toISOString().replace(/[:.]/g, '-')));
  await mkdir(outputDir, { recursive: true });
  const workspace = await mkdtemp(join(tmpdir(), 'return-review-consumer-'));
  const installDir = join(workspace, 'install');
  const evidence = {
    status: 'failed',
    input: isTarball ? 'local tarball' : input,
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    checks: {},
    browsers: [],
    browserCounts: { passed: 0, unavailable: 0, failed: 0 },
    limitations: [
      'Synthetic fixture data only; no authenticated or production system tested.',
      'Playwright checks accessible names and UI behavior, not VoiceOver spoken output.',
      `Host OS ${process.platform} only; other operating systems are not exercised by this run.`,
    ],
  };

  try {
    await mkdir(installDir);
    await writeFile(join(installDir, 'package.json'), JSON.stringify({ name: 'return-review-package-consumer', private: true }));
    await runFile(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--package-lock=false', spec],
      { cwd: installDir, timeout: 180_000, maxBuffer: 1024 * 1024 });
    const packageDir = join(installDir, 'node_modules', '@ihyeon', 'return-review-console');
    const metadata = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'));
    assert.equal(metadata.name, packageName);
    if (!isTarball) assert.equal(input, `${metadata.name}@${metadata.version}`, 'installed exact registry version');
    assert.equal(metadata.license, 'MIT', 'installed package must declare MIT');
    assert.equal(metadata.homepage, projectUrl, 'homepage must link to this project');
    const license = await readFile(join(packageDir, 'LICENSE'), 'utf8');
    assert.match(license, /MIT License/);
    assert.match(license, /Copyright/);
    assert.match(license, /Permission is hereby granted/);
    const readme = await readFile(join(packageDir, 'README.md'), 'utf8');
    assert.ok(readme.includes(projectUrl), 'README must link to this project');
    assert.match(readme, /^# Return Review Console$/m, 'English guide must be bundled');
    assert.match(readme, /^\[한국어\]\(https:\/\/github\.com\/hyeonse-swing\/return-review-console\/blob\/main\/README\.ko\.md\)/m, 'Korean guide must link to GitHub');
    assert.doesNotMatch(readme, /^## 한국어$/m, 'npm README must contain only the English guide');
    assert.doesNotMatch(readme, /https?:\/\/design-system\.hyeonse\.dev/i, 'README must not link to the design system as this project');
    assert.doesNotMatch(readme, /playwright install|npm run test:package/i, 'public README must omit developer-only package checks');
    assert.ok(metadata.bin?.[binName], 'package must register return-review-console binary');
    const bin = join(installDir, 'node_modules', '.bin', binName);
    assert.ok((await stat(bin)).isFile(), 'npm binary link must resolve to an executable file');
    const before = await packageFingerprint(packageDir);
    const help = await runCli(bin, ['--help'], installDir);
    assert.match(help, /사용법:/, 'default CLI help must be Korean');
    assert.match(help, /--data-dir/);
    assert.match(help, /--port/);
    assert.match(help, /--lang ko\|en/);
    const englishHelp = await runCli(bin, ['--lang', 'en', '--help'], installDir);
    assert.match(englishHelp, /Usage:/, 'English CLI help must be English');
    assert.match(englishHelp, /--lang ko\|en/);
    const version = await runCli(bin, ['--version'], installDir);
    assert.equal(version, metadata.version);
    evidence.package = { name: metadata.name, version: metadata.version, license: metadata.license, homepage: metadata.homepage, bin: binName };
    evidence.checks.bundledLicenseAndGuides = true;
    evidence.checks.cliRegistration = true;
    evidence.checks.helpAndVersion = true;
    const englishCli = await startCli(bin, installDir, join(workspace, 'english-cli-data'), 'en');
    try {
      assert.equal(new URL(englishCli.advertisedUrl).searchParams.get('lang'), 'en', 'English startup URL must select English');
      requireStatus(await fetch(englishCli.origin), 200, 'English CLI server');
      evidence.checks.englishStartupUrl = true;
    } finally {
      await stopCli(englishCli.child);
    }

    evidence.checks.restartAndConcurrency = await checkRestartAndConcurrency(bin, installDir, workspace);
    evidence.checks.crossProcessConcurrency = await checkCrossProcessConcurrency(bin, installDir, workspace);
    for (const [name, browserType] of Object.entries(browserTypes)) {
      try {
        evidence.browsers.push(await checkBrowser(name, browserType, bin, installDir, workspace, outputDir));
      } catch (error) {
        evidence.browsers.push({ browser: name, status: 'failed', reason: String(error.message).replaceAll(workspace, '<temporary workspace>') });
        throw error;
      }
    }
    evidence.checks.installedPackageUnchanged = before === await packageFingerprint(packageDir);
    assert.ok(evidence.checks.installedPackageUnchanged, 'runtime wrote mutable state under installed package');
    evidence.status = evidence.browsers.some(result => result.status === 'unavailable') ? 'passed_with_unavailable_browsers' : 'passed';
    console.log(`Installed package consumer check passed: ${metadata.name}@${metadata.version}`);
    console.log(`Browsers: ${evidence.browsers.map(result => `${result.browser}=${result.status}`).join(', ')}`);
  } catch (error) {
    evidence.failure = { name: error.name, message: String(error.message).replaceAll(workspace, '<temporary workspace>') };
    throw error;
  } finally {
    for (const result of evidence.browsers) evidence.browserCounts[result.status] += 1;
    await writeFile(join(outputDir, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`);
    await rm(workspace, { recursive: true, force: true });
    console.log(`Evidence: ${outputDir}`);
  }
}

await main();
