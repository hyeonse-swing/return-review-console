import { createHash } from 'node:crypto';
import { readFile, appendFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = '@ihyeon/return-review-console';
const REPOSITORY = 'hyeonse-swing/return-review-console';
const REPOSITORY_URL = `git+https://github.com/${REPOSITORY}.git`;
const REGISTRY = 'https://registry.npmjs.org/@ihyeon%2freturn-review-console';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERIFY_TIMEOUT_MS = 12 * 60_000;
const VERIFY_INTERVAL_MS = 10_000;

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

function canonicalTarballUrl(version) {
  versionParts(version);
  return `https://registry.npmjs.org/@ihyeon/return-review-console/-/return-review-console-${version}.tgz`;
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

export async function checkPublicArchive(version, expectedIntegrity, request = fetch) {
  const response = await request(canonicalTarballUrl(version), {
    cache: 'no-store',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (response.status !== 200) throw new Error(`npm public tarball: HTTP ${response.status}`);
  const actualIntegrity = `sha512-${createHash('sha512').update(Buffer.from(await response.arrayBuffer())).digest('base64')}`;
  if (actualIntegrity !== expectedIntegrity) throw new Error('npm public tarball bytes differ from the tested artifact');
  return true;
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
  const expectedTarballUrl = canonicalTarballUrl(pkg.version);
  const deadline = Date.now() + VERIFY_TIMEOUT_MS;
  let pending = 'registry metadata or latest tag is pending';
  while (true) {
    const registry = await readRegistry();
    if (registry.name !== NAME) throw new Error('npm registry returned a different package');
    const released = registry.versions?.[pkg.version];
    if (released?.dist?.integrity && released.dist.integrity !== integrity) {
      throw new Error('npm registry tarball integrity differs from the tested artifact');
    }
    if (released?.dist?.tarball && released.dist.tarball !== expectedTarballUrl) {
      throw new Error('npm registry tarball URL differs from the canonical npm archive URL');
    }
    if (released?.dist?.integrity === integrity && released.dist.tarball === expectedTarballUrl) {
      const available = await checkPublicArchive(pkg.version, integrity);
      if (available && registry['dist-tags']?.latest === pkg.version) {
        console.log(`npm confirms ${NAME}@${pkg.version} as latest; public tarball HTTP 200 and SHA512 match the tested artifact`);
        return;
      }
      pending = available ? 'latest tag is pending' : 'public tarball HTTP 404 is pending';
    } else {
      pending = 'registry metadata is pending';
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    console.log(`${NAME}@${pkg.version}: ${pending}; retrying in ${Math.min(VERIFY_INTERVAL_MS, remaining)}ms`);
    await new Promise(done => setTimeout(done, Math.min(VERIFY_INTERVAL_MS, remaining)));
  }
  throw new Error(`npm did not confirm ${NAME}@${pkg.version} after 12 minutes: ${pending}`);
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
