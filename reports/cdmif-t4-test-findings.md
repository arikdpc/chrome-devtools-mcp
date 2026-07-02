# cdmif-t4 — Behavioral test of the #1521 isolation + teardown fix

**Date:** 2026-07-02
**Target:** `@arikdpc/chrome-devtools-mcp@0.24.0-fork.1`, branch `fork-patches`, built tree at
`/home/dev/workspace/chrome-devtools-mcp-fork/build/` (T2 commit `23a2a02` + T3 commit `e7bd19c`).
**Scope:** read-only behavioral test against a **disposable** Chrome on `127.0.0.1:9333`. No source/config/prod touched.

## Verdict

**FIX NOT VALIDATED.** Two blocking defects found in the built fork. The per-session isolation
change (T2) makes every isolated session **unusable** (cannot open or even list a page), and the
teardown (T3) **never fires** on subprocess disconnect, so per-session BrowserContexts **leak** in the
shared Chrome.

| # | Assertion | Result |
|---|-----------|--------|
| 1 | No cross-session bleed | **FAIL** (blocked — `new_page` errors; no page ever created) |
| 2 | Foreign/default tab invisible | INCONCLUSIVE (true structurally, but not behaviorally exercised) |
| 3 | Correct-tab addressing (core #1521 repro) | **FAIL** (blocked — cannot open/select/evaluate) |
| 4 | Original repro never returns foreign data | INCONCLUSIVE (vacuous — no data returned at all) |
| 5 | Teardown / no leak on disconnect | **FAIL** (context count 3→3, not −1; leak) |
| 6 | No leak under cycling | **FAIL** (context count grows 4→5→6 monotonically; leak) |

---

## Setup / commands

- Port check: `ss -ltn | grep ':9333'` → free.
- Disposable Chrome (throwaway `--user-data-dir`, headless, isolated from prod):
  ```
  /usr/bin/google-chrome --remote-debugging-port=9333 --user-data-dir=$(mktemp -d) \
    --headless=new --no-first-run --no-default-browser-check --disable-gpu --no-sandbox about:blank
  ```
  Reported: `Chrome/141.0.7390.122`.
- One **extra `about:blank`** tab opened in the **default** context via the puppeteer-core oracle
  (stands in for the persistent/foreign #1521 tab).
- MCP instances launched per session (two = sessions A and B):
  ```
  node /home/dev/workspace/chrome-devtools-mcp-fork/build/src/bin/chrome-devtools-mcp.js \
    --browserUrl=http://127.0.0.1:9333
  ```
  (bin path read from `package.json` → `bin.chrome-devtools-mcp`).
- Driver: throwaway ESM script `/tmp/cdmif-t4/driver.mjs` using the fork's installed
  `@modelcontextprotocol/sdk` `Client` + `StdioClientTransport` to drive tools, and the fork's
  `puppeteer-core` (`puppeteer.connect({browserURL})`) as an independent oracle for
  `browserContexts().length` / per-context `pages()`. Oracle always `disconnect()`s (never closes the browser).
- Env for MCP subprocess: `CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS=1`, `CHROME_DEVTOOLS_MCP_NO_USAGE_STATISTICS=1`, `CI=1` (kept fully offline).
- **Only `127.0.0.1:9333` was ever contacted.** The production Chrome `192.168.1.175:9222` and the live proxy were never touched.

---

## Raw evidence

### Oracle: contexts exist and are isolated, but session contexts are EMPTY

Pre-session (only the disposable Chrome, with the extra foreign tab):
```
count: 1
  context[default=true] pages: ["about:blank","about:blank"]
```
Baseline after both sessions A and B connect + each attempted `new_page`:
```
count: 3
  context[default=true]  pages: ["about:blank","about:blank"]   <- the two foreign tabs
  context[default=false] pages: []                              <- Session A's per-session BrowserContext (EMPTY)
  context[default=false] pages: []                              <- Session B's per-session BrowserContext (EMPTY)
```
→ T2 **does** create a separate BrowserContext per session (good, structural isolation present), but
each stays **empty** — no page is ever created in it.

### Every tool call fails with "No page selected"

```
[A] new_page   {url:"data:text/html,<h1>A1PAGE</h1>"} -> Error: No page selected
[B] new_page   {url:"data:text/html,<h1>B1PAGE</h1>"} -> Error: No page selected
[A] list_pages                                        -> Error: No page selected
[B] list_pages                                        -> Error: No page selected
[A] select_page / evaluate_script                     -> Error: No page selected
```

Server-side DEBUG trace of a single `new_page` (from `/tmp/cdmif-t4/probe.mjs`, `stderr=pipe`) shows
`createBrowserContext` succeeding (`{"result":{"browserContextId":"CBCB4E43..."}}`) and then the error
returned **before any page target is created** — i.e. the handler body never runs; the throw is at the
pre-handler guard.

### Teardown / leak (oracle ground truth)

```
--- Disconnect Session A (client.close: stdin.end -> 2s -> SIGTERM) ---
A.pid alive after close: false          (process was killed)
ORACLE before A close: count=3
ORACLE after  A close: count=3          EXPECTED 2  -> context NOT closed -> LEAK
[B] list_pages after A close: []        (B also unusable — same deadlock)

--- Cycle a fresh session connect/disconnect 3x ---
cycle 0: post-close context count = 4
cycle 1: post-close context count = 5
cycle 2: post-close context count = 6   EXPECTED stable  -> +1 leaked per disconnect
```

---

## Per-assertion detail (observed vs expected)

**1. No cross-session bleed — FAIL (blocked).**
Expected: A lists only A1, B lists only B1. Observed: both `new_page` calls returned `Error: No page
selected`; both `list_pages` returned `Error: No page selected`. No page could be created in either
session, so the bleed test cannot execute. (No bleed *occurred*, but only vacuously.)

**2. Foreign/default tab invisible — INCONCLUSIVE.**
The oracle confirms the two foreign `about:blank` tabs live in the **default** context, which
`#getAllPages` excludes by construction (sources only `#sessionContext ∪ #isolatedContexts`). So the
scoping is structurally correct. But because no session page could ever be created/listed, this was
not exercised behaviorally — marking INCONCLUSIVE rather than a real PASS.

**3. Correct-tab addressing (core #1521 repro) — FAIL (blocked).**
Expected: open A2, `select_page(A1)` → `evaluate_script(()=>location.href)` returns A1's URL; re-select
A2 → returns A2's URL. Observed: `new_page`/`select_page`/`evaluate_script` all returned `Error: No
page selected`; page IDs could not even be resolved (`A1=undefined A2=undefined`). Cannot execute.

**4. Original repro never returns foreign data — INCONCLUSIVE.**
No output referenced the foreign `about:blank` tab — but only because every call errored and returned
no page data at all. Vacuous; not a meaningful pass.

**5. Teardown / no leak on disconnect — FAIL.**
Expected: disconnect A → `browserContexts().length` drops by 1; Chrome + B unaffected (B still lists
B1). Observed: count stayed **3 → 3** (A's context leaked); B could not list B1 (same deadlock). The A
subprocess was killed by SIGTERM without its BrowserContext being closed.

**6. No leak under cycling — FAIL.**
Expected: 3 connect/disconnect cycles leave context count stable. Observed: **4 → 5 → 6**, +1 leaked
BrowserContext per disconnect.

---

## Root cause — two distinct blocking defects

### Defect A — Isolation deadlock: fresh session context has no page, but the per-tool guard requires one

- `McpContext.#init()` (`build/src/McpContext.js:74-84`) creates `#sessionContext =
  browser.createBrowserContext()` — an **empty** context — and does **not** create a seed page in it.
- T2 rescoped `#getAllPages` to source pages only from the owned (empty) `#sessionContext` instead of
  `browser.pages()`. So `createPagesSnapshot` finds **0 pages**, the auto-select at
  `McpContext.js:443-446` never runs, and `#selectedPage` stays `undefined`.
- The per-tool dispatch wrapper (`build/src/index.js:210-217`) calls
  `context.getSelectedMcpPage()` **before every handler** (for any tool without an explicit
  `pageId`). With no selected page this throws `No page selected`
  (`McpContext.js:329-332`) — **including for `new_page` and `list_pages`**, the very tools you would
  use to create/see the first page.

Result: a freshly isolated session is a **chicken-and-egg deadlock** — it can never open its first
page, so no tool works. In upstream/non-isolated 0.24.0 this never surfaced because the shared browser
always had ≥1 existing tab, so `#selectedPage` was always defined on the first call. T2 removed that
seed without adding one.

**Fix direction (not applied — out of scope):** in `#init`, after creating `#sessionContext`, seed an
initial page (`await this.#sessionContext.newPage()`) so there is always a selectable page — OR make
the `index.js` guard tolerate "no selected page" for navigation/read-only tools
(`new_page`, `list_pages`).

### Defect B — Teardown never fires on subprocess disconnect: BrowserContexts leak

- `disposeSession()` (`McpContext.js:107`, closes `#sessionContext`) is wired **only** to
  `server.server.onclose` (`build/src/index.js:124-125`).
- The stdio entrypoint `build/src/bin/chrome-devtools-mcp-main.js` installs **no** `SIGTERM`/`SIGINT`
  handler, and `StdioServerTransport` only listens for stdin `'data'`/`'error'` — it does **not** fire
  `onclose` on stdin EOF. So when a client disconnects, `StdioClientTransport.close()` does
  `stdin.end()` → waits 2s → `SIGTERM` → the subprocess is killed **without** `onclose` ever firing.
- Because the browser is reached via `connect()` (long-lived shared Chrome), the per-session
  BrowserContext created over that connection is **not** auto-closed when the client process dies — it
  persists in Chrome.

Result: every session disconnect leaks one BrowserContext in the shared Chrome (confirmed: 3→3 on
single disconnect; 4→5→6 across 3 cycles). This is exactly the leak T3 was meant to prevent; the hook
it chose does not run under the real subprocess-kill disconnect path.

**Fix direction (not applied — out of scope):** additionally trigger `disposeSession()` from a
`process.on('SIGTERM'/'SIGINT')` handler (and/or on stdin `'end'`) in the stdio entrypoint, awaiting
the context close before exit — `onclose` alone is insufficient for the stdio subprocess model.

---

## Cleanup

- Disposable Chrome killed; temp `--user-data-dir` removed; all MCP node subprocesses exited.
- `ss -ltn | grep ':9333'` → **free** (nothing lingers).
- Throwaway scripts removed from `/tmp/cdmif-t4/` after the report was written.
- No source/config/build changes: `git -C .../chrome-devtools-mcp-fork status --porcelain` shows only
  this report file.

## Network scope

Only `http://127.0.0.1:9333` (the disposable Chrome) was contacted. The production Chrome
`192.168.1.175:9222` and the live devtools proxy were never touched. MCP update/usage-stats network
calls were disabled via env.
