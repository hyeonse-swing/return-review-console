# Return Review Console · 리턴 데스크

[English](#english) · [한국어](#한국어) · [Web demo](https://return-desk.hyeonse.dev) · [npm package](https://www.npmjs.com/package/@ihyeon/return-review-console) · [GitHub](https://github.com/hyeonse-swing/return-review-console)

## English

Review synthetic returns in a local browser app. Approve a pending return directly, or put it on hold with a reason. Another reviewer can inspect that reason and approve or reject it. The console includes six sample returns, a two-reviewer conflict scenario, and a review history that survives a restart.

### Try the web demo

Open the [Return Desk demo](https://return-desk.hyeonse.dev/?lang=en) in your browser. The demo uses sample returns and stores review history in this browser. To see an approval conflict, open the same pending return in two tabs of the same browser profile and select a different reviewer in each tab. **Reset demo** restores the samples. The npm version below runs a local server and saves its history to SQLite.

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

The server compares `If-Match` with the record version and returns `412` with the latest record to a stale editor. If an approval response is lost, use **Check approval result** to retry the same request. The console keeps that request when you reload the same tab. A request that was already committed returns its saved response, even after a server restart.

### Hold and reinspect

Open a pending return, choose **Put on hold**, and enter a reason. The record moves to **Awaiting reinspection**. Another reviewer can read the hold reason in the list and history, then choose **Approve after reinspection** or **Reject return**. Rejection requires a reason. Both decisions close the record. The list filters and counts include pending, held, approved, and rejected records. A stale editor sees the latest record and keeps their draft.

The HTTP API uses `POST /api/returns/:id/hold`, `/reapprove`, and `/reject` with the same `If-Match` and optional `Idempotency-Key` as the existing direct approval endpoint. Request IDs bind to the decision, record, prior version, reviewer, and note. Previous SQLite records and approval receipts remain readable. The demo stores decisions in IndexedDB and keeps them across reloads in the same browser profile.

The server binds to the local loopback interface. The package is released under the MIT license and includes notices for bundled dependencies.

## 한국어

합성 반품을 검수하는 로컬 브라우저 앱입니다. 대기 건을 바로 승인하거나 이유를 남겨 보류하고, 다음 담당자가 재검수 후 승인·반려할 수 있습니다. 예시 반품 6건과 재실행해도 남는 처리 내역을 제공합니다.

### 설치 없이 체험

[리턴 데스크 데모](https://return-desk.hyeonse.dev/?lang=ko)를 브라우저에서 여세요. 샘플 반품으로 실습하며 검수 내역은 이 브라우저에 저장됩니다. 같은 브라우저의 두 탭에서 검수 대기 건을 열고 각각 다른 담당자를 선택하면 승인 충돌을 체험할 수 있습니다. **데모 초기화**로 처음 샘플로 돌아갈 수 있습니다. 아래 npm 버전은 로컬 서버를 실행하고 승인 기록을 SQLite에 저장합니다.

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

서버는 `If-Match`를 현재 기록 버전과 비교합니다. 오래된 요청에는 `412`와 함께 최신 기록을 반환합니다. 승인 응답이 끊기면 **승인 결과 확인**에서 같은 요청으로 다시 확인할 수 있습니다. 같은 탭을 새로고침해도 해당 요청을 이어서 확인할 수 있어요. 이미 처리된 요청은 서버를 재시작한 뒤에도 저장된 결과를 반환합니다.

### 보류와 재검수

검수 대기 건에서 **보류하기**를 눌러 필수 사유를 입력하면 **재검수 대기**가 됩니다. 다른 담당자는 목록과 처리 내역에서 사유를 읽고 **재검수 승인** 또는 **반려하기**를 선택합니다. 반려에는 사유가 필요합니다. 최종 결정을 내리면 해당 반품은 종결됩니다. 목록 필터와 건수는 검수 대기·재검수 대기·승인·반려를 각각 보여줍니다. 오래된 화면에서 결정을 내리면 최신 상태를 받고 작성 중인 초안은 보존합니다.

HTTP API는 기존 직접 승인 주소와 같은 `If-Match` 및 선택적 `Idempotency-Key`를 사용해 `POST /api/returns/:id/hold`, `/reapprove`, `/reject`를 제공합니다. 요청 ID는 결정 종류·반품·이전 버전·담당자·메모에 묶입니다. 예전 SQLite 반품과 승인 영수증은 그대로 읽을 수 있습니다. 웹 데모는 IndexedDB에 결정을 보관해 같은 브라우저 프로필에서 새로고침한 뒤에도 볼 수 있습니다.

서버는 로컬 루프백에서 실행됩니다. MIT 라이선스로 배포하며 번들 의존성의 라이선스 고지를 함께 제공합니다.
