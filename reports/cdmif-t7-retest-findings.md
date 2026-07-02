# cdmif-t7 — Behavioral re-test after Defect-A (T5) + Defect-B (T6) fixes

**Date:** 2026-07-02
**Task:** Re-run of cdmif-t4-test (which FAILED) after the two blocking fixes landed.
**Verdict:** ✅ **FIX VALIDATED** — all 6 assertions PASS.

## Scope / safety
- Read-only vs source/config/infra. No source, config, or production touched.
- Production Chrome `192.168.1.175:9222` and the live proxy were **never contacted**.
- Only a **disposable headless Chrome on `127.0.0.1:9333`** (fresh `--user-data-dir`) was used.

## Fork under test
- Path: `/home/dev/workspace/chrome-devtools-mcp-fork`, branch `fork-patches`.
- Package: `@arikdpc/chrome-devtools-mcp@0.24.0-fork.1`.
- Commits in build (verified present, top of branch):
  - `352d697` cdmif-t6-sigterm — await disposeSession on SIGTERM/SIGINT/stdin end (Defect B)
  - `1ac39b2` cdmif-t5-seedpage — seed a page in `#init` so isolated sessions are usable (Defect A)
  - `e7bd19c` cdmif-t3-teardown, `23a2a02` cdmif-t2-isolation (stacked underneath)
- Rebuild: `npm ci && npm run build` → `tsc + post-build` clean.
- Fix wiring confirmed in the built artifacts before testing:
  - `build/src/McpContext.js:83` — `await this.#sessionContext.newPage();` (T5 seed).
  - `build/src/bin/chrome-devtools-mcp-main.js:63-74` — `SIGTERM`/`SIGINT`/stdin `end`/`close` → `gracefulShutdown` → `await shutdown()` → `disposeSession()` (T6).

## Harness
- MCP entrypoint per session: `node build/src/bin/chrome-devtools-mcp.js --browserUrl=http://127.0.0.1:9333`
  (bin path confirmed from `package.json` `bin`).
- Env: `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`, `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`, `CI=1`.
- Driver: throwaway ESM using the fork's `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport`; two Clients = sessions **A** and **B**.
- Oracle: fork's `puppeteer-core` `connect({browserURL})`; read `browserContexts().length` and per-context `pages()`; always `disconnect()` without closing the browser.
- Foreign/#1521 stand-in: Chrome launched with `about:blank`; oracle opened **one extra** `about:blank` in the **default** context → default context holds 2 `about:blank` pages, none owned by any session.

### Commands
```
# rebuild
cd /home/dev/workspace/chrome-devtools-mcp-fork && npm ci && npm run build

# disposable Chrome
google-chrome --headless=new --remote-debugging-port=9333 \
  --user-data-dir=$(mktemp -d) --no-first-run --no-default-browser-check --disable-gpu about:blank

# driver (ESM, fork node_modules via symlink)
node /tmp/cdmif-t7/driver.mjs
```

## Context-count model (oracle)
`browserContexts()` = default (foreign) + one per live session.
Note: the per-session `BrowserContext` is created **lazily on the first tool call** (`getContext()`), not at MCP `connect`, so counts rise after `new_page`, not at handshake — expected.

| Point | Contexts | Detail |
|---|---|---|
| baseline (Chrome + foreign tab, no sessions) | 1 | default: `[about:blank, about:blank]` |
| A+B connected & active (before disconnect A) | 3 | default + B(`example.net`) + A(`example.org, example.com`) |
| after disconnect A | 2 | default + B(`example.net`) |
| after disconnect A **and** B | 1 | default only |
| cycling (3×) | 1 → 1 each cycle | no growth |

---

## Assertions

### Assertion 1 — Session usable + no bleed — ✅ PASS
- A `new_page https://example.com/` → success (no "No page selected").
- B `new_page https://example.net/` → success.
- A `list_pages`:
  ```
  ## Pages
  1: about:blank
  2: https://example.com/ [selected]
  ```
- B `list_pages`:
  ```
  ## Pages
  1: about:blank
  2: https://example.net/ [selected]
  ```
- A does NOT list `example.net` (B's page) nor any foreign tab. B does NOT list `example.com` (A's page).
- Each session's page list = its own seed `about:blank` + its own opened page. Exactly 1 `about:blank` per session (its own seed).

### Assertion 2 — Foreign/default tab invisible — ✅ PASS
- Default context holds 2 `about:blank` (launch tab + oracle-opened foreign tab). Neither session lists them.
- `A_blank_count = 1`, `B_blank_count = 1` — i.e. each session sees only its own seed `about:blank`, zero foreign `about:blank`.

### Assertion 3 — Correct-tab addressing (core #1521 repro) — ✅ PASS
- A opened A2 `https://example.org/`. Page handles: A1 id=2 (`example.com`), A2 id=3 (`example.org`).
- `select_page(pageId=2)` then `evaluate_script(() => location.href)`:
  ```
  Script ran on page and returned:
  ```json
  "https://example.com/"
  ```
  ```
- `select_page(pageId=3)` then `evaluate_script(() => location.href)`:
  ```
  Script ran on page and returned:
  ```json
  "https://example.org/"
  ```
  ```
- Selected page and the CDP target used by `evaluate_script` are in sync. `pageId` handles resolve to the correct tab in both directions.

### Assertion 4 — Original #1521 repro fails to reproduce — ✅ PASS
- Across both evaluate calls, results were `example.com` / `example.org` — the intended tabs.
- No evaluate ever returned foreign/default (`about:blank` / `claude.ai`) data. `foreign_leak = false`.

### Assertion 5 — Teardown / no leak on disconnect — ✅ PASS
- Oracle before disconnect A: **3** contexts.
- `A.client.close()` (stdio transport close → stdin end → SIGTERM path), 2.5 s settle.
- Oracle after: **2** contexts → dropped by exactly **1** (A's context closed).
- B still lists its own pages after A's disconnect:
  ```
  1: about:blank
  2: https://example.net/ [selected]
  ```
- Chrome + session B unaffected.

### Assertion 6 — No leak under cycling — ✅ PASS
- Baseline (default only) = **1**.
- 3× connect → open work → disconnect:
  | cycle | during (connected) | after close |
  |---|---|---|
  | 0 | 1 | 1 |
  | 1 | 1 | 1 |
  | 2 | 1 | 1 |
- Final context count = **1**. No monotonic growth.
  (Note: "during=1" reflects lazy context creation — the cycle sessions were connected but did no page-op before the oracle read, so their context wasn't created yet; each fully cleaned up regardless.)

---

## Before/after vs cdmif-t4 failures

| Assertion | cdmif-t4 (before T5/T6) | cdmif-t7 (after T5/T6) |
|---|---|---|
| 1 (usable + no bleed) | **BLOCKED** — Defect A: `new_page`/`list_pages` threw "No page selected"; session could never open its first page | ✅ **PASS** — sessions usable, no cross-session bleed |
| 3 (correct-tab addressing) | **BLOCKED** — could not reach the repro (Defect A) | ✅ **PASS** — `select_page`→`evaluate_script` hits the addressed tab both ways |
| 5 (teardown on disconnect) | **FAIL** — Defect B: contexts 3→3, context leaked on single disconnect | ✅ **PASS** — 3→2, drops exactly 1; B unaffected |
| 6 (no leak under cycling) | **FAIL** — Defect B: 4→5→6 monotonic growth | ✅ **PASS** — stable at baseline every cycle |

- **Defect A (seed page, T5)** confirmed fixed: sessions with an empty context now auto-open a seed `about:blank`, so `getSelectedMcpPage()` succeeds and the first `new_page`/`list_pages` no longer throws.
- **Defect B (SIGTERM/stdin teardown, T6)** confirmed fixed: the per-session `BrowserContext` is closed on disconnect (stdin end / SIGTERM), no leak in the shared Chrome, no growth under cycling.

## One-line verdict
**FIX VALIDATED** — isolated sessions are usable, no cross-session/foreign bleed, correct-tab addressing by `pageId`, the original #1521 repro no longer reproduces, and per-session contexts close cleanly on disconnect (no leak, single or cycling).

## Cleanup
- Disposable Chrome killed (targeted PID + `fuser -k 9333/tcp`). Port `9333` confirmed free (`curl` refused, 0 listeners).
- No MCP node subprocess or Chrome using the t7 `--user-data-dir` remains.
- Temp `--user-data-dir` and `/tmp` driver/scripts removed.
- Production Chrome/proxy never touched.
