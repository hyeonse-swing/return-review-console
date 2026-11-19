#!/usr/bin/env node

import { mkdir, open, readFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { join, resolve, isAbsolute } from 'node:path';

const defaultPort = 4332;
const databaseFile = 'console.sqlite';
let outputLang = 'ko';

const messages = {
  ko: {
    missingValue: (name) => `${name} 뒤에 값을 입력하세요.`,
    invalidPort: '--port는 0부터 65535까지의 정수여야 합니다.',
    unknownArgument: (arg) => `알 수 없는 인수: ${arg}`,
    portInUse: (port) => `포트 ${port}가 이미 사용 중입니다. --port로 다른 포트를 지정하세요.`,
    portDenied: (port) => `포트 ${port}를 열 권한이 없습니다. --port로 다른 포트를 지정하세요.`,
    directoryFailed: (dataDir) => `데이터 폴더를 만들 수 없습니다: ${dataDir} (같은 이름의 파일이 있는지 확인하세요.)`,
    pathIsDirectory: (dataDir) => `데이터 파일 경로가 폴더입니다: ${join(dataDir, databaseFile)}`,
    dataDenied: (dataDir) => `데이터 폴더 또는 파일에 쓸 수 없습니다: ${dataDir} (권한을 확인하거나 --data-dir로 다른 폴더를 지정하세요.)`,
    sqliteFailed: (dataDir, reason) => `데이터 파일을 열 수 없습니다: ${join(dataDir, databaseFile)} (${reason})`,
    storageFailed: (dataDir) => `반품 검수 저장소를 열 수 없습니다: ${join(dataDir, databaseFile)}`,
    running: (url, dataDir) => `반품 검수 콘솔 실행 중: ${url}\n데이터 폴더: ${dataDir}\n종료하려면 Ctrl+C를 누르세요.\n`,
    error: '오류',
  },
  en: {
    missingValue: (name) => `Enter a value after ${name}.`,
    invalidPort: '--port must be an integer from 0 to 65535.',
    unknownArgument: (arg) => `Unknown argument: ${arg}`,
    portInUse: (port) => `Port ${port} is already in use. Choose another port with --port.`,
    portDenied: (port) => `Cannot listen on port ${port}. Choose another port with --port.`,
    directoryFailed: (dataDir) => `Cannot create the data directory: ${dataDir} (check for a file with the same name.)`,
    pathIsDirectory: (dataDir) => `The data file path is a directory: ${join(dataDir, databaseFile)}`,
    dataDenied: (dataDir) => `Cannot write to the data directory or file: ${dataDir} (check permissions or choose another --data-dir.)`,
    sqliteFailed: (dataDir, reason) => `Cannot open the data file: ${join(dataDir, databaseFile)} (${reason})`,
    storageFailed: (dataDir) => `Cannot open the return review storage: ${join(dataDir, databaseFile)}`,
    running: (url, dataDir) => `Return Review Console running: ${url}\nData directory: ${dataDir}\nPress Ctrl+C to stop.\n`,
    error: 'Error',
  },
};

class CliInputError extends Error {}

function defaultDataDirectory() {
  const home = homedir();
  if (platform() === 'darwin') return join(home, 'Library', 'Application Support', 'return-review-console');
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'return-review-console');
  const xdgDataHome = process.env.XDG_DATA_HOME;
  return join(xdgDataHome && isAbsolute(xdgDataHome) ? xdgDataHome : join(home, '.local', 'share'), 'return-review-console');
}

function readOption(args, index, name, lang) {
  const arg = args[index];
  const value = arg === name ? args[index + 1] : arg.slice(name.length + 1);
  if (value === undefined || value === '' || value.startsWith('--')) {
    throw new CliInputError(messages[lang].missingValue(name));
  }
  return { value, nextIndex: arg === name ? index + 1 : index };
}

function parseLanguage(args) {
  let lang;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg !== '--lang' && !arg.startsWith('--lang=')) continue;
    const value = arg === '--lang' ? args[index + 1] : arg.slice('--lang='.length);
    if (value !== 'ko' && value !== 'en') {
      throw new CliInputError('--lang: ko 또는 en을 입력하세요. / Enter ko or en for --lang.');
    }
    lang = value;
    if (arg === '--lang') index += 1;
  }
  return lang;
}

function parseArgs(args) {
  const requestedLanguage = parseLanguage(args);
  const lang = requestedLanguage ?? 'ko';
  outputLang = lang;
  if (args.includes('--help') || args.includes('-h')) return { command: 'help', lang };
  if (args.includes('--version') || args.includes('-v')) return { command: 'version', lang };

  let port = defaultPort;
  let dataDir = defaultDataDirectory();
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--data-dir' || arg.startsWith('--data-dir=')) {
      const option = readOption(args, index, '--data-dir', lang);
      dataDir = option.value;
      index = option.nextIndex;
    } else if (arg === '--port' || arg.startsWith('--port=')) {
      const option = readOption(args, index, '--port', lang);
      if (!/^(0|[1-9]\d*)$/.test(option.value) || Number(option.value) > 65535) {
        throw new CliInputError(messages[lang].invalidPort);
      }
      port = Number(option.value);
      index = option.nextIndex;
    } else if (arg === '--lang' || arg.startsWith('--lang=')) {
      if (arg === '--lang') index += 1;
    } else {
      throw new CliInputError(messages[lang].unknownArgument(arg));
    }
  }
  return { command: 'serve', port, dataDir: resolve(dataDir), lang, requestedLanguage };
}

function printHelp(lang) {
  if (lang === 'en') {
    process.stdout.write(`Return Review Console\n\nUsage:\n  return-review-console [--data-dir <path>] [--port <number>] [--lang ko|en]\n\nOptions:\n  --data-dir <path>  Data directory (default: user data directory)\n  --port <number>    Local server port 0–65535 (default: ${defaultPort}; 0 selects an available port)\n  --lang ko|en       Interface and CLI language (default: ko)\n  --version          Print version\n  --help             Print help\n\nOpen the printed 127.0.0.1 address in your browser. The console uses synthetic return data.\n`);
    return;
  }
  process.stdout.write(`반품 검수 콘솔\n\n사용법:\n  return-review-console [--data-dir <경로>] [--port <번호>] [--lang ko|en]\n\n옵션:\n  --data-dir <경로>  데이터 저장 폴더 (기본값: 사용자 데이터 폴더)\n  --port <번호>     로컬 서버 포트 0~65535 (기본값: ${defaultPort}; 0은 빈 포트 자동 선택)\n  --lang ko|en      화면과 CLI 언어 (기본값: ko)\n  --version         버전 출력\n  --help            도움말 출력\n\n브라우저에서 표시된 127.0.0.1 주소를 여세요. 합성 반품 데이터로 검수 흐름을 연습할 수 있습니다.\n`);
}

function explainError(error, port, dataDir, lang, phase = 'data') {
  const copy = messages[lang];
  if (error instanceof CliInputError) return error.message;
  if (error?.code === 'EADDRINUSE') return copy.portInUse(port);
  if (error?.code === 'EACCES' && phase === 'listen') return copy.portDenied(port);
  if (error?.code === 'EEXIST' || error?.code === 'ENOTDIR') {
    return copy.directoryFailed(dataDir);
  }
  if (error?.code === 'EISDIR') return copy.pathIsDirectory(dataDir);
  if (error?.code === 'EACCES' || error?.code === 'EPERM' || error?.code === 'EROFS') {
    return copy.dataDenied(dataDir);
  }
  if (error?.code === 'ERR_SQLITE_ERROR') {
    return copy.sqliteFailed(dataDir, error.message);
  }
  if (error?.name === 'StorageError') return copy.storageFailed(dataDir);
  return error instanceof Error ? error.message : String(error);
}

function listen(server, port) {
  return new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
}

function closeServer(server) {
  return new Promise((resolveClose) => {
    try {
      const wasListening = server.listening;
      let timer;
      server.close(() => {
        if (timer) clearTimeout(timer);
        resolveClose();
      });
      if (wasListening) {
        timer = setTimeout(() => server.closeAllConnections(), 5000);
        timer.unref();
      }
    } catch {
      resolveClose();
    }
  });
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help') return printHelp(options.lang);
  if (options.command === 'version') {
    const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    process.stdout.write(`${manifest.version}\n`);
    return;
  }

  try {
    await mkdir(options.dataDir, { recursive: true, mode: 0o700 });
    try {
      const database = await open(join(options.dataDir, databaseFile), 'wx', 0o600);
      await database.close();
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  } catch (error) {
    throw new Error(explainError(error, options.port, options.dataDir, options.lang));
  }

  let server;
  let phase = 'data';
  try {
    const { createReturnServer } = await import('../server/index.mjs');
    server = createReturnServer({ qa: false, databasePath: join(options.dataDir, databaseFile) });
    phase = 'listen';
    await listen(server, options.port);
  } catch (error) {
    if (server) await closeServer(server);
    throw new Error(explainError(error, options.port, options.dataDir, options.lang, phase));
  }

  const address = server.address();
  const languageQuery = options.requestedLanguage ? `/?lang=${options.requestedLanguage}` : '';
  const url = `http://127.0.0.1:${address.port}${languageQuery}`;
  process.stdout.write(messages[options.lang].running(url, options.dataDir));

  let stopping = false;
  async function stop(exitCode) {
    if (stopping) return;
    stopping = true;
    process.exitCode = exitCode;
    await closeServer(server);
  }

  process.once('SIGINT', () => { void stop(130); });
  process.once('SIGTERM', () => { void stop(143); });
  server.on('error', (error) => {
    process.stderr.write(`${messages[options.lang].error}: ${explainError(error, options.port, options.dataDir, options.lang)}\n`);
    void stop(1);
  });
}

main().catch((error) => {
  process.stderr.write(`${messages[outputLang].error}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = error instanceof CliInputError ? 2 : 1;
});
