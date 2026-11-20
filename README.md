# Return Review Console

[한국어](https://github.com/hyeonse-swing/return-review-console/blob/main/README.ko.md) · [Web demo](https://return-desk.hyeonse.dev) · [npm package](https://www.npmjs.com/package/@ihyeon/return-review-console) · [GitHub](https://github.com/hyeonse-swing/return-review-console)

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

Use **Copy activity history** in a return's details to copy its ID, current status, and dated decisions with reviewer names and notes.

The HTTP API uses `POST /api/returns/:id/hold`, `/reapprove`, and `/reject` with the same `If-Match` and optional `Idempotency-Key` as the existing direct approval endpoint. Request IDs bind to the decision, record, prior version, reviewer, and note. Previous SQLite records and approval receipts remain readable. The demo stores decisions in IndexedDB and keeps them across reloads in the same browser profile.

The **Returns awaiting reinspection** table shows held records. Use the received-date heading to sort by date, with return ID breaking ties. Select one record with its checkbox, then move between pages to keep that selection. **Open details** opens a record without changing the checkbox selection. When a selected record is completed, the selection clears on refresh. Each page shows two records so the paging behavior is visible with three held samples.

The server binds to the local loopback interface. The package is released under the MIT license and includes notices for bundled dependencies.
