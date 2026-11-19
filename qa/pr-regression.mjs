import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const qaDirectory = join(projectDirectory, 'qa');
const cliDirectory = join(projectDirectory, 'node_modules', '.bin');
const commands = [];
let outputDirectory;
let server;
let origin;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function save(name, value) {
  await writeFile(join(outputDirectory, name), `${JSON.stringify(value, null, 2)}\n`);
}

function runCli(program, args, acceptedCodes = [0]) {
  const result = spawnSync(join(cliDirectory, program), args, {
    cwd: projectDirectory,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: 180_000,
  });
  commands.push({ program, args, exitCode: result.status, stdout: result.stdout, stderr: result.stderr });
  if (result.error) throw result.error;
  assert(acceptedCodes.includes(result.status), `${program} ${args[0]} exited ${result.status}: ${result.stderr || result.stdout}`);
  return result;
}

function reportPath(result) {
  const path = result.stdout.match(/^Raw result:\s*(.+)$/m)?.[1]?.trim();
  assert(path, `Flow QA did not print a raw result path: ${result.stdout}`);
  return path;
}

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function request(path, options) {
  const response = await fetch(new URL(path, origin), options);
  assert(response.ok, `${options?.method || 'GET'} ${path} returned ${response.status}`);
  return response.status === 204 ? undefined : response.json();
}

async function startServer() {
  server = spawn(process.execPath, ['server/index.mjs'], {
    cwd: projectDirectory,
    env: { ...process.env, PORT: '0', RETURN_QA: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  server.stdout.on('data', (chunk) => chunks.push(chunk));
  server.stderr.on('data', (chunk) => chunks.push(chunk));
  server.on('exit', () => writeFile(join(outputDirectory, 'server.log'), Buffer.concat(chunks)).catch(() => {}));
  let lastError;
  let startError;
  server.once('error', error => { startError = error; });
  for (let attempt = 0; attempt < 100; attempt++) {
    if (startError || server.exitCode !== null) break;
    origin ??= Buffer.concat(chunks).toString('utf8').match(/http:\/\/127\.0\.0\.1:[1-9]\d*/)?.[0];
    if (origin) {
      try {
        const { records } = await request('/api/returns');
        assert(records.some((record) => record.id === 'RET-2421' && record.status === 'pending'),
          'The required pending synthetic return is missing.');
        const page = await fetch(origin);
        assert(page.ok && page.headers.get('content-type')?.includes('text/html'),
          `The app entry page is unavailable at ${origin} (${page.status}).`);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Local app did not start. ${(startError ?? lastError)?.message || ''} ${Buffer.concat(chunks).toString('utf8')}`);
}

async function setFault(on) {
  await request('/__qa/fault', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ on }),
  });
}

function isApprovalFailure(event) {
  if (event?.type !== 'http' || event?.message !== 'HTTP 503' || event?.network?.status !== 503) return false;
  if (event.network.method !== 'POST') return false;
  try {
    return new URL(event.network.url).pathname === '/api/returns/RET-2421/approve';
  } catch {
    return false;
  }
}

async function capturedFailure() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { batches } = await request('/__qa/events');
    const events = batches.flatMap((batch) => Array.isArray(batch?.events) ? batch.events : []);
    const event = events.find(isApprovalFailure);
    if (event) return { event, batches };
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error('The collector did not receive the SDK HTTP 503 event within 20 seconds.');
}

async function captureSdkFailure() {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.goto(origin);
    await page.getByTestId('row-RET-2421').click();
    await page.getByRole('button', { name: '승인하기' }).click();
    await page.getByRole('dialog', { name: '반품 승인' }).waitFor();
    await page.getByRole('button', { name: '승인 확정' }).click();
    const alert = page.getByRole('alert');
    await alert.waitFor();
    assert((await alert.textContent())?.trim() === '승인 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.',
      'The synthetic 503 did not show the required retry notice.');
    await page.screenshot({ path: join(outputDirectory, 'capture-fault.png') });
    return await capturedFailure();
  } finally {
    await browser.close();
  }
}

async function main() {
  await mkdir(join(qaDirectory, '.runs'), { recursive: true });
  outputDirectory = await mkdtemp(join(qaDirectory, '.runs', 'pr-'));
  await startServer();
  await setFault(true);
  const { event, batches } = await captureSdkFailure();
  assert(typeof event.eventId === 'string' && event.eventId.length > 0, 'Captured event has no SDK event ID.');
  await save('collector-batches.json', { batches });
  const capturedPath = join(outputDirectory, 'captured.json');
  await save('captured.json', { schemaVersion: 1, events: [event] });

  const firstAnalysis = join(outputDirectory, 'first-analysis');
  runCli('error-to-test', ['analyze', '--input', capturedPath, '--out', firstAnalysis]);
  const first = await readJson(join(firstAnalysis, 'analysis.json'));
  assert(first.groups.length === 1 && first.groups[0].eventIds.includes(event.eventId), 'Error-to-Test did not group the captured event.');
  assert(first.groups[0].type === 'http' && first.groups[0].message === 'HTTP 503', 'Unexpected Error-to-Test group.');

  const profile = {
    schemaVersion: 'error-to-test/profile-1',
    name: 'Return approval outage regression',
    scenarios: [{
      id: `review-${first.groups[0].id}`,
      title: '반품 승인 후 완료 상태 확인',
      match: { groupId: first.groups[0].id },
      requirement: '검수 대기 중인 반품은 승인 API가 성공하면 승인 완료로 표시된다.',
      expectedSource: 'Return Review Console QA acceptance in qa/README.md: RET-2421 approval shows 승인 완료 when the API succeeds.',
      preconditions: ['RET-2421 is a pending synthetic return in a fresh local server.'],
      setupConfirmed: true,
      questions: [],
      steps: [
        { type: 'open', path: '/' },
        { type: 'click', locator: { by: 'testId', value: 'row-RET-2421' } },
        { type: 'click', locator: { by: 'role', value: 'button', name: '승인하기' } },
        { type: 'assertVisible', locator: { by: 'role', value: 'dialog', name: '반품 승인' }, visible: true },
        { type: 'click', locator: { by: 'role', value: 'button', name: '승인 확정' } },
        { type: 'assertText', locator: { by: 'testId', value: 'record-status' }, expected: '승인 완료', match: 'equals' },
      ],
    }],
  };
  const profilePath = join(outputDirectory, 'review-profile.json');
  await save('review-profile.json', profile);
  const reviewed = join(outputDirectory, 'reviewed');
  runCli('error-to-test', ['analyze', '--input', capturedPath, '--profile', profilePath, '--reviewed', '--out', reviewed]);
  runCli('error-to-test', ['verify', reviewed, '--input', capturedPath, '--profile', profilePath]);
  runCli('error-to-test', ['readiness', reviewed]);
  const workspace = join(outputDirectory, 'workspace');
  runCli('error-to-test', ['prepare-run', reviewed, '--out', workspace, '--input', capturedPath, '--profile', profilePath]);
  runCli('flow-qa', ['validate', 'cases/error-to-test.json', '--workspace', workspace]);
  runCli('flow-qa', ['connect', 'local', '--url', origin, '--workspace', workspace]);

  const failure = runCli('flow-qa', ['run', 'cases/error-to-test.json', '--target', 'local', '--workspace', workspace], [1]);
  const failureReport = await readJson(reportPath(failure));
  assert(failureReport.status === 'failed' && failureReport.cases.length === 1 && failureReport.cases[0].status === 'failed', 'Fault run did not fail the approval assertion.');
  assert(failureReport.cases[0].attempts?.some((attempt) =>
    attempt.error?.code === 'ASSERTION_FAILED' &&
    attempt.steps?.some((step) => step.status === 'failed' && step.label?.includes('record-status'))),
  'Fault run failed for a reason other than the approval status assertion.');
  runCli('error-to-test', ['link-run', reviewed, '--report', reportPath(failure)]);
  const failedGate = runCli('error-to-test', ['results', reviewed, '--require-pass', '--format', 'json'], [2]);
  const failedSummary = JSON.parse(failedGate.stdout);
  assert(failedSummary.latestRun?.runId === failureReport.runId && failedSummary.counts.failed === 1, 'Failure gate did not identify the expected run.');
  await save('failure-gate.json', failedSummary);

  await setFault(false);
  const recovered = runCli('flow-qa', ['run', 'cases/error-to-test.json', '--target', 'local', '--workspace', workspace]);
  const recoveryReport = await readJson(reportPath(recovered));
  assert(recoveryReport.status === 'passed' && recoveryReport.cases.length === 1 && recoveryReport.cases[0].status === 'passed', 'Recovery run did not pass.');
  assert(failureReport.suiteHash === recoveryReport.suiteHash, 'Failure and recovery used different suites.');
  const caseId = failureReport.cases[0].id;
  assert(typeof caseId === 'string' && caseId.length > 0 && caseId === recoveryReport.cases[0].id,
    'Failure and recovery did not use the same case ID.');
  runCli('error-to-test', ['link-run', reviewed, '--report', reportPath(recovered)]);
  const passedGate = runCli('error-to-test', ['results', reviewed, '--require-pass', '--format', 'json']);
  const passedSummary = JSON.parse(passedGate.stdout);
  assert(passedSummary.latestRun?.runId === recoveryReport.runId && passedSummary.counts.passed === 1, 'Recovery gate did not identify the expected run.');
  await save('recovery-gate.json', passedSummary);
  const trace = runCli('error-to-test', ['trace', reviewed, '--event-id', event.eventId, '--format', 'json']);
  const traced = JSON.parse(trace.stdout);
  assert(traced.found && traced.eventId === event.eventId && traced.matches?.some((match) =>
    match.groupId === first.groups[0].id && match.cases?.some((item) => item.caseId === caseId && item.status === 'passed')),
  'The captured event did not trace to the same reviewed case that passed after recovery.');
  await save('event-trace.json', traced);

  await save('summary.json', {
    origin,
    eventId: event.eventId,
    caseId,
    capturedEventSha256: createHash('sha256').update(JSON.stringify(event)).digest('hex'),
    suiteHash: failureReport.suiteHash,
    failureRunId: failureReport.runId,
    recoveryRunId: recoveryReport.runId,
    failedGateExitCode: failedGate.status,
    passedGateExitCode: passedGate.status,
    result: 'passed',
  });
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = [
      ['Browser Error Log · captured HTTP 503', event.eventId],
      ['Error to Test · reviewed case', caseId],
      ['Flow QA · failed while faulted', failureReport.runId],
      ['Flow QA · passed after recovery', recoveryReport.runId],
    ];
    assert(rows.every(([, id]) => typeof id === 'string' && /^[A-Za-z\d_-]+$/.test(id)), 'Unexpected regression evidence ID format.');
    await appendFile(process.env.GITHUB_STEP_SUMMARY, [
      '## Return Desk · Browser error to regression',
      '',
      'A synthetic return approval produced an HTTP 503. The same reviewed case failed during the fault and passed after recovery.',
      '',
      '| Step | ID |',
      '| --- | --- |',
      ...rows.map(([label, id]) => `| ${label} | \`${id}\` |`),
      '',
      '[English walkthrough](https://github.com/hyeonse-swing/return-review-console/blob/main/qa/README.md#english) · [한국어 예제](https://github.com/hyeonse-swing/return-review-console/blob/main/qa/README.md#한국어)',
      '',
    ].join('\n'));
  }
  console.log(`PR regression passed. Evidence: ${outputDirectory}`);
}

try {
  await main();
} catch (error) {
  console.error(error);
  if (outputDirectory) console.error(`Partial evidence: ${outputDirectory}`);
  process.exitCode = 1;
} finally {
  if (outputDirectory) await save('commands.json', commands).catch(() => {});
  if (server?.pid && server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await new Promise((done) => {
      server.once('exit', done);
      setTimeout(() => { server.kill('SIGKILL'); done(); }, 3000).unref();
    });
  }
}
