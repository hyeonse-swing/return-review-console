import { createServer } from 'node:http';
import { lstat, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openReturnStorage, StorageError } from './storage.mjs';
import fixtures from '../shared/fixtures.json' with { type: 'json' };

const distDirectory = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));
const maxRequestBytes = 64 * 1024;
const maxCollectedBatches = 64;

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  response.end(JSON.stringify(value));
}

function versionTag(record) {
  return `"${record.version}"`;
}

async function readJson(request) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'JSON 요청만 받을 수 있습니다.');
  }

  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      throw new HttpError(413, 'BODY_TOO_LARGE', '요청 본문이 너무 큽니다.');
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'INVALID_JSON', '올바른 JSON 본문이 필요합니다.');
  }
}

async function serveStatic(pathname, response) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    json(response, 400, { code: 'INVALID_PATH', message: '경로를 읽을 수 없습니다.' });
    return;
  }

  if (decodedPath.includes('\\') || decodedPath.split('/').includes('..') || decodedPath.split('/').some(part => part.startsWith('.'))) {
    json(response, 404, { code: 'NOT_FOUND', message: '페이지를 찾을 수 없습니다.' });
    return;
  }

  const relativePath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = resolve(distDirectory, `.${relativePath}`);
  if (filePath !== distDirectory && !filePath.startsWith(`${distDirectory}${sep}`)) {
    json(response, 404, { code: 'NOT_FOUND', message: '페이지를 찾을 수 없습니다.' });
    return;
  }

  try {
    const fileStat = await lstat(filePath);
    if (fileStat.isFile()) {
      const file = await readFile(filePath);
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(filePath)] ?? 'application/octet-stream' });
      response.end(file);
      return;
    }
  } catch (error) {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  }

  if (!extname(decodedPath) && !decodedPath.startsWith('/__')) {
    try {
      const index = await readFile(resolve(distDirectory, 'index.html'));
      response.writeHead(200, { 'Content-Type': mimeTypes['.html'] });
      response.end(index);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  json(response, 404, { code: 'NOT_FOUND', message: '페이지를 찾을 수 없습니다.' });
}

export function createReturnServer({ qa = process.env.RETURN_QA === '1', databasePath } = {}) {
  const storage = openReturnStorage({ databasePath, fixtures });
  const batches = [];
  let approvalFault = false;

  const server = createServer(async (request, response) => {
    try {
      const host = request.headers.host;
      const port = server.address()?.port;
      if (typeof host !== 'string' ||
          (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        throw new HttpError(421, 'MISDIRECTED_REQUEST', '이 서버 주소로 요청해 주세요.');
      }
      if (request.method !== 'GET' && request.method !== 'HEAD' &&
          request.headers.origin !== undefined && request.headers.origin !== `http://${host}`) {
        throw new HttpError(403, 'INVALID_ORIGIN', '이 서버에서 시작한 요청만 처리할 수 있습니다.');
      }

      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      const method = request.method;

      if (method === 'GET' && pathname === '/api/returns') {
        json(response, 200, { records: storage.list() });
        return;
      }

      const recordMatch = /^\/api\/returns\/(RET-\d+)$/.exec(pathname);
      if (recordMatch) {
        const record = storage.get(recordMatch[1]);
        if (!record) throw new HttpError(404, 'NOT_FOUND', '반품 건을 찾을 수 없습니다.');

        if (method === 'GET') {
          json(response, 200, { record }, { ETag: versionTag(record) });
          return;
        }
      }

      const transitionMatch = /^\/api\/returns\/(RET-\d+)\/(approve|hold|reapprove|reject|assign|unassign)$/.exec(pathname);
      if (method === 'POST' && transitionMatch) {
        const [, id, command] = transitionMatch;
        const record = storage.get(id);
        if (!record) throw new HttpError(404, 'NOT_FOUND', '반품 건을 찾을 수 없습니다.');

        const ifMatch = request.headers['if-match'];
        if (!ifMatch) throw new HttpError(428, 'PRECONDITION_REQUIRED', '최신 버전으로 다시 요청해 주세요.');
        if (typeof ifMatch !== 'string' || !/^"[1-9]\d*"$/.test(ifMatch)) {
          throw new HttpError(400, 'INVALID_VERSION', '올바른 If-Match 버전이 필요합니다.');
        }

        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) ||
            typeof body.reviewer !== 'string' || !body.reviewer.trim() || body.reviewer.trim().length > 40 ||
            (body.memo !== undefined && (typeof body.memo !== 'string' || body.memo.trim().length > 500)) ||
            (command === 'hold' || command === 'reject') && (typeof body.memo !== 'string' || !body.memo.trim())) {
          throw new HttpError(400, 'INVALID_REVIEW', '담당자와 500자 이내의 검수 메모를 확인해 주세요.');
        }

        const rawKey = request.headers['idempotency-key'];
        if ((command === 'assign' || command === 'unassign') && rawKey === undefined) {
          throw new HttpError(428, 'IDEMPOTENCY_KEY_REQUIRED', '요청 ID가 필요합니다.');
        }
        if (rawKey !== undefined && (typeof rawKey !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(rawKey))) {
          throw new HttpError(400, 'INVALID_IDEMPOTENCY_KEY', '올바른 요청 ID가 필요합니다.');
        }
        const key = rawKey?.toLowerCase();
        const reviewer = body.reviewer.trim();
        const memo = body.memo?.trim() ?? '';
        const result = storage.transition({ command, id: record.id, ifMatch, reviewer, memo, key, unavailable: approvalFault });
        if (result.kind === 'reusedKey') {
          throw new HttpError(409, 'IDEMPOTENCY_KEY_REUSED', '같은 요청 ID로 다른 결정을 보낼 수 없습니다.');
        }
        if (result.kind === 'notFound') throw new HttpError(404, 'NOT_FOUND', '반품 건을 찾을 수 없습니다.');
        if (result.kind === 'unavailable') {
          json(response, 503, { code: command === 'approve' ? 'APPROVAL_UNAVAILABLE' : 'REVIEW_UNAVAILABLE',
            message: command === 'approve' ? '승인을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.' : '결정을 처리할 수 없습니다. 잠시 후 다시 시도해 주세요.' });
          return;
        }
        if (result.kind === 'stale') {
          json(response, 412, { code: 'STALE_VERSION', message: '다른 담당자가 먼저 이 반품 건을 처리했습니다.', record: result.record }, { ETag: result.etag });
          return;
        }
        if (result.kind === 'invalidTransition') {
          const alreadyApproved = command === 'approve' && result.record.status === 'approved';
          json(response, 409, { code: alreadyApproved ? 'ALREADY_APPROVED' : 'INVALID_TRANSITION',
            message: alreadyApproved ? '이미 승인된 반품 건입니다.' : '현재 상태에서 처리할 수 없는 결정입니다.',
            record: result.record }, { ETag: result.etag });
          return;
        }
        json(response, 200, { record: result.record }, { ETag: result.etag });
        return;
      }

      if (method === 'POST' && pathname === '/api/client-errors') {
        const batch = await readJson(request);
        if (!batch || typeof batch !== 'object' || Array.isArray(batch)) {
          throw new HttpError(400, 'INVALID_BATCH', '오류 배치가 필요합니다.');
        }
        batches.push(batch);
        if (batches.length > maxCollectedBatches) batches.shift();
        response.writeHead(204, { 'Cache-Control': 'no-store' });
        response.end();
        return;
      }

      if (qa && method === 'GET' && pathname === '/__qa/events') {
        json(response, 200, { batches });
        return;
      }
      if (qa && method === 'PUT' && pathname === '/__qa/fault') {
        const body = await readJson(request);
        if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.on !== 'boolean') {
          throw new HttpError(400, 'INVALID_FAULT', 'on 값은 boolean이어야 합니다.');
        }
        approvalFault = body.on;
        json(response, 200, { on: approvalFault });
        return;
      }

      if (pathname === '/api' || pathname.startsWith('/api/') || pathname === '/__qa' || pathname.startsWith('/__qa/')) {
        throw new HttpError(404, 'NOT_FOUND', 'API 경로를 찾을 수 없습니다.');
      }
      if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', '허용되지 않은 요청입니다.');
      await serveStatic(pathname, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error);
        return;
      }
      if (error instanceof HttpError) {
        json(response, error.status, { code: error.code, message: error.message });
        return;
      }
      if (error instanceof StorageError) {
        json(response, 503, { code: 'STORAGE_UNAVAILABLE', message: '저장소를 사용할 수 없습니다. 잠시 후 다시 시도해 주세요.' });
        return;
      }
      json(response, 500, { code: 'INTERNAL_ERROR', message: '서버 오류가 발생했습니다.' });
    }
  });
  server.once('close', () => storage.close());
  return server;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PORT ?? 4332);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT는 0부터 65535 사이의 정수여야 합니다.');
  }
  const server = createReturnServer({ databasePath: process.env.RETURN_CONSOLE_DB || undefined });
  server.listen(port, '127.0.0.1', () => {
    console.info(`반품 검수 콘솔 서버 http://127.0.0.1:${server.address().port}`);
  });
}
