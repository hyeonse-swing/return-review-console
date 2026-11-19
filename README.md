# Return Review Console · 리턴 데스크

[English](#english) · [한국어](#한국어) · [npm package](https://www.npmjs.com/package/@ihyeon/return-review-console) · [GitHub](https://github.com/hyeonse-swing/return-review-console)

## English

Review and approve synthetic returns in a local browser app. The console includes six sample returns, a two-reviewer conflict scenario, and an approval history that survives a restart.

### Start from npm

Use Node.js 22.13 or later. Run the command and open the address printed in your terminal. The default port is `4332`. Use `--port 0` to choose an available port.

```sh
npx --yes @ihyeon/return-review-console@latest --lang en
```

Use the language selector to switch the interface at any time. For a fresh set of sample returns, supply a new `--data-dir`. The same directory preserves approval records and information used to replay an approval request. Use synthetic data for the exercises.

```sh
npx --yes @ihyeon/return-review-console@latest --lang en --data-dir ./return-review-data --port 0
npx --yes @ihyeon/return-review-console@latest --lang en --help
```

### Try a conflicting approval

1. Open the running app in two tabs and select `RET-2418` in both. Choose **Minseo** in one tab and **Jihoon** in the other.
2. Open **Approve return** in both tabs and enter different notes. Choose **Confirm approval** in Minseo’s tab first.
3. Choose **Confirm approval** in Jihoon’s tab. The console shows that another reviewer completed the return and keeps Jihoon’s draft in that tab. Choose **Close and view history** to see the single recorded approval.

The server compares `If-Match` with the record version and returns `412` with the latest record to a stale editor. If an approval response is lost, retrying with the same `Idempotency-Key` and request body returns the saved response, even after a server restart.

The server binds to the local loopback interface. The package is released under the MIT license and includes notices for bundled dependencies.

## 한국어

합성 반품을 조회하고 승인하는 로컬 브라우저 앱입니다. 예시 반품 6건, 두 담당자의 승인 충돌 실습, 재실행해도 남는 승인 기록을 제공합니다.

### npm에서 실행

Node.js 22.13 이상에서 다음 명령을 실행하고, 터미널에 표시된 주소를 여세요. 기본 포트는 `4332`입니다. `--port 0`은 비어 있는 포트를 선택합니다.

```sh
npx --yes @ihyeon/return-review-console@latest --lang ko
```

화면의 언어 선택에서 한국어와 영어를 전환할 수 있습니다. 다른 실습을 시작하려면 새 `--data-dir`을 지정하세요. 같은 폴더를 사용하면 승인 기록과 재시도 정보가 유지됩니다. 실습에는 합성 데이터를 사용하세요.

```sh
npx --yes @ihyeon/return-review-console@latest --lang ko --data-dir ./return-review-data --port 0
npx --yes @ihyeon/return-review-console@latest --lang ko --help
```

### 두 담당자의 승인 충돌 체험

1. 실행한 앱을 두 탭에서 열고 `RET-2418`을 선택합니다. 한 탭에서 **민서**, 다른 탭에서 **지훈**을 선택합니다.
2. 두 탭에서 **승인하기**를 열고 서로 다른 메모를 입력합니다. 민서 탭에서 먼저 **승인 확정**을 누릅니다.
3. 지훈 탭에서 **승인 확정**을 누르면 다른 담당자가 먼저 처리했다는 안내가 나오고 초안은 해당 탭에 남습니다. **닫고 내역 보기**에서 승인 기록이 한 건인지 확인합니다.

서버는 `If-Match`를 현재 기록 버전과 비교합니다. 오래된 요청에는 `412`와 함께 최신 기록을 반환합니다. 승인 응답이 끊긴 경우, 같은 `Idempotency-Key`와 요청 내용으로 재시도하면 서버 재시작 뒤에도 저장한 결과를 반환합니다.

서버는 로컬 루프백에서 실행됩니다. MIT 라이선스로 배포하며 번들 의존성의 라이선스 고지를 함께 제공합니다.
