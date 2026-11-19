import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { checkPublicArchive, readRegistry, releaseDecision } from './npm-release.mjs';

const name = '@ihyeon/return-review-console';
const repository = 'git+https://github.com/hyeonse-swing/return-review-console.git';
const manifest = version => ({ name, version, repository: { url: repository } });
const lock = version => ({ name, version, packages: { '': { name, version } } });
const registry = (versions, latest) => ({
  name,
  versions: Object.fromEntries(versions.map(version => [version, { name, version }])),
  'dist-tags': { latest },
});

test('an existing version is skipped without requiring newly added repository metadata', () => {
  assert.deepEqual(releaseDecision({ name, version: '0.1.1' }, lock('0.1.1'), registry(['0.1.0', '0.1.1'], '0.1.1')), {
    version: '0.1.1', shouldPublish: false, reason: 'already published',
  });
});

test('a new version requires matching repository metadata and a newer version', () => {
  assert.equal(releaseDecision(manifest('0.1.2'), lock('0.1.2'), registry(['0.1.1'], '0.1.1')).shouldPublish, true);
  assert.throws(() => releaseDecision({ name, version: '0.1.2' }, lock('0.1.2'), registry(['0.1.1'], '0.1.1')), /repository\.url/);
  assert.throws(() => releaseDecision(manifest('0.1.0'), lock('0.1.0'), registry(['0.1.1'], '0.1.1')), /newer/);
  assert.throws(() => releaseDecision(manifest('0.1.2'), lock('0.1.1'), registry(['0.1.1'], '0.1.1')), /versions must match/);
});

test('registry errors cannot be interpreted as a missing version', async () => {
  await assert.rejects(readRegistry(async () => ({ ok: false, status: 503 })), /HTTP 503/);
  await assert.rejects(readRegistry(async () => ({ ok: false, status: 404 })), /HTTP 404/);
  assert.throws(() => releaseDecision(manifest('0.1.2'), lock('0.1.2'), {}), /invalid package metadata/);
});

test('public archive requires canonical URL, HTTP 200, and the exact tested bytes', async () => {
  const bytes = Buffer.from('tested release archive');
  const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
  const request = async (url, options) => {
    assert.equal(url, 'https://registry.npmjs.org/@ihyeon/return-review-console/-/return-review-console-0.1.2.tgz');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.redirect, 'error');
    return { status: 200, arrayBuffer: async () => bytes };
  };
  assert.equal(await checkPublicArchive('0.1.2', integrity, request), true);
  await assert.rejects(checkPublicArchive('0.1.2', integrity, async () => ({ status: 200, arrayBuffer: async () => Buffer.from('other') })), /bytes differ/);
});

test('public tarball HTTP 404 stays pending; other failures stop verification', async () => {
  assert.equal(await checkPublicArchive('0.1.2', 'sha512-test', async () => ({ status: 404 })), false);
  await assert.rejects(checkPublicArchive('0.1.2', 'sha512-test', async () => ({ status: 503 })), /HTTP 503/);
});
