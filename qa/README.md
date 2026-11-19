# PR 회귀 검사 예제

[Browser Error Log](https://github.com/hyeonse-swing/browser-error-log)로 오류를 수집하고, [Error to Test](https://github.com/hyeonse-swing/error-to-test)에서 회귀 케이스를 검토한 뒤, [Flow QA](https://github.com/hyeonse-swing/flow-qa)에서 실패와 복구를 확인한다. 콘솔 화면은 [Hyeonse Design System](https://design-system.hyeonse.dev)의 구성 요소를 사용한다.

이 예제는 합성 반품 `RET-2421`을 승인하는 화면을 검증한다. 승인 API가 성공하면 화면에 `승인 완료`가 표시돼야 한다. API가 503을 반환하면 승인되지 않은 상태를 유지하고 `승인 요청을 처리하지 못했어요. 잠시 후 다시 시도해 주세요.`를 표시해야 한다. 이 기대 결과는 이 프로젝트의 검수 승인 요구사항이다.

`npm run qa:pr`는 사용 가능한 로컬 포트에서 앱 서버를 실행하고, QA 전용 장애를 켜서 503을 재현한다. Chromium에서 오류 안내를 확인하고 Browser Error Log가 전송한 이벤트를 수집기에서 조회한다. Error-to-Test는 해당 오류 ID로 그룹과 검토된 케이스를 만들고, Flow QA는 같은 케이스를 장애 상태와 복구 상태에서 각각 실행한다. 실패 실행에서는 `--require-pass`가 코드 2, 복구 실행에서는 코드 0을 반환해야 전체 스크립트가 성공한다.

```sh
npm ci
npm test
npm run build
npx --no-install flow-qa browser install
npm run test:browser
npm run qa:pr
```

결과는 `qa/.runs/pr-*`에 저장된다. `summary.json`은 원본 오류 ID, 동일 suite 해시, 실패·복구 run ID와 두 게이트의 종료 코드를 기록한다. `collector-batches.json`은 로컬 수집기가 받은 SDK 배치, `captured.json`은 503에 해당하는 SDK 이벤트 한 건, `reviewed/`는 Error-to-Test 분석과 연결된 결과, `workspace/.flowqa/runs/`는 Flow QA의 브라우저 보고서다. 별도 동시 승인 브라우저 검사는 `output/browser/`에 기록한다. 이 파일들은 `.gitignore`로 제외하며 CI에서는 실패할 때도 아티팩트로 보관한다.

별도 저장소에 적용할 때는 `.github/workflows/ci.yml`의 검증 단계와 `qa/`를 참고한다. `package.json`의 `qa:pr` 실행 명령과 공개 QA 패키지 버전을 옮기고 `test:browser`는 해당 앱의 브라우저 검사 명령으로 바꾼다. 앱 시작과 상태 확인 경로, 합성 테스트 데이터, 화면에서 사용하는 이름, 검토된 요구사항은 각 서비스에 맞게 수정한다. 아티팩트에는 합성 QA 결과만 포함한다. 운영 서비스의 수집률과 안정성은 별도 측정이 필요하다.

## 배포 파일 검사 · Package checks

콘솔 소스의 루트에서 `npm ci`와 `npm run build`를 실행한다. 패키지 검사는 배포 파일을 빈 폴더에 설치해 세 브라우저에서 동작을 확인한다. 게시 전에는 tarball 경로를, 게시 후에는 정확한 npm 버전을 전달한다.

From the source project root, run `npm ci` and `npm run build`. The package check installs the artifact in an empty directory and runs it in three browsers. Pass a tarball before publishing or an exact npm version after publishing.

```sh
npx --no-install playwright install chromium firefox webkit
npm run test:package -- @ihyeon/return-review-console@0.1.2
```

워크플로의 PR 실행과 수동 실행은 모두 이 프로젝트의 로컬 합성 서버를 사용한다. Actions에서 실행한 결과는 워크플로가 저장한 아티팩트로 확인한다.

## 자동 npm 게시 · Automatic npm releases

개인 GitHub 저장소의 `main`에 새 패키지 버전을 푸시하면 `ci.yml`이 테스트를 실행한다. npm에 아직 없는 새 버전은 검증을 통과한 압축파일로 게시한다. 이미 공개된 버전은 그대로 사용한다. npm Trusted Publisher는 `hyeonse-swing/return-review-console`의 `ci.yml`에 연결한다.

A push to `main` runs verification. The workflow publishes the tested tarball when the package version is new and skips versions that already exist. npm Trusted Publishing uses `ci.yml` in `hyeonse-swing/return-review-console`.

## 웹 데모 · Web demo

Vercel은 `main`의 정적 데모를 빌드하고 [return-desk.hyeonse.dev](https://return-desk.hyeonse.dev)에 배포한다. 이 데모의 승인 검증은 브라우저에서 실행한다. 위 PR 회귀 검사는 로컬 서버와 오류 수집기에서 실행한다.

Vercel builds the static demo from `main` and publishes it to [return-desk.hyeonse.dev](https://return-desk.hyeonse.dev). Demo approvals run in the browser. The PR regression scenario above runs against the local server and error collector.

```sh
npm run build:demo
node checks/web-demo.mjs
node checks/web-demo.mjs https://return-desk.hyeonse.dev
```
