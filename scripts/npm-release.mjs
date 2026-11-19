import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = '@ihyeon/return-review-console';
const REPOSITORY = 'hyeonse-swing/return-review-console';
const REPOSITORY_URL = `git+https://github.com/${REPOSITORY}.git`;
const REGISTRY = 'https://registry.npmjs.org/@ihyeon%2freturn-review-console';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function versionParts(value) {
  const match = VERSION.exec(value ?? '');
  if (!match) throw new Error(`Release version must be plain X.Y.Z: ${value}`);
  return match.slice(1).map(BigInt);
}

function newerThan(current, previous) {
  const a = versionParts(current);
  const b = versionParts(previous);
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return false;
}

export function releaseDecision(pkg, lock, registry) {
  if (pkg.name !== NAME || lock.name !== NAME || lock.packages?.['']?.name !== NAME) {
    throw new Error(`Release package name must be ${NAME} in package.json and package-lock.json`);
  }
  const version = pkg.version;
  versionParts(version);
  if (lock.version !== version || lock.packages[''].version !== version) {
    throw new Error('package.json and package-lock.json versions must match');
  }
  if (registry?.name !== NAME || !registry.versions || typeof registry.versions !== 'object') {
    throw new Error('npm registry returned invalid package metadata');
  }
  const latest = registry['dist-tags']?.latest;
  versionParts(latest);
  const published = registry.versions[version];
  if (published) {
    if (published.name !== NAME || published.version !== version) {
      throw new Error(`npm registry returned invalid metadata for ${version}`);
    }
    return { version, shouldPublish: false, reason: 'already published' };
  }
  if (!newerThan(version, latest)) {
    throw new Error(`${version} must be newer than npm latest ${latest}`);
  }
  if (pkg.repository?.url !== REPOSITORY_URL) {
    throw new Error(`repository.url must be ${REPOSITORY_URL}`);
  }
  return { version, shouldPublish: true, reason: 'new release' };
}

export async function readRegistry(request = fetch) {
  const response = await request(REGISTRY, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`npm registry metadata: HTTP ${response.status}`);
  const registry = await response.json();
  if (!registry || typeof registry !== 'object') throw new Error('npm registry returned invalid JSON');
  return registry;
}

function assertReleaseContext() {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  if (process.env.GITHUB_REPOSITORY !== REPOSITORY || process.env.GITHUB_EVENT_NAME !== 'push' || process.env.GITHUB_REF !== 'refs/heads/main') {
    throw new Error('npm publishing is only allowed on the canonical main push');
  }
}

async function gate() {
  assertReleaseContext();
  const [pkg, lock, registry] = await Promise.all([
    readFile('package.json', 'utf8').then(JSON.parse),
    readFile('package-lock.json', 'utf8').then(JSON.parse),
    readRegistry(),
  ]);
  const decision = releaseDecision(pkg, lock, registry);
  if (process.env.GITHUB_ACTIONS === 'true' && !process.env.GITHUB_OUTPUT) throw new Error('GITHUB_OUTPUT is required');
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(process.env.GITHUB_OUTPUT, `version=${decision.version}\nshould_publish=${decision.shouldPublish}\n`);
  }
  console.log(`${NAME}@${decision.version}: ${decision.reason}`);
}

async function verify(tarball) {
  assertReleaseContext();
  if (!tarball?.endsWith('.tgz')) throw new Error('Usage: npm-release.mjs verify <release.tgz>');
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  versionParts(pkg.version);
  const integrity = `sha512-${createHash('sha512').update(await readFile(tarball)).digest('base64')}`;
  for (let attempt = 1; attempt <= 15; attempt++) {
    const registry = await readRegistry();
    if (registry.name !== NAME) throw new Error('npm registry returned a different package');
    const released = registry.versions?.[pkg.version];
    if (released?.dist?.integrity === integrity && registry['dist-tags']?.latest === pkg.version) {
      console.log(`npm confirms ${NAME}@${pkg.version} as latest with the tested tarball integrity`);
      return;
    }
    if (released?.dist?.integrity && released.dist.integrity !== integrity) {
      throw new Error('npm registry tarball integrity differs from the tested artifact');
    }
    if (attempt < 15) await new Promise(done => setTimeout(done, 10_000));
  }
  throw new Error(`npm did not confirm ${NAME}@${pkg.version} as latest with the tested tarball integrity`);
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'gate') return gate();
  if (mode === 'verify') return verify(process.argv[3]);
  throw new Error('Usage: npm-release.mjs gate|verify <release.tgz>');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}
