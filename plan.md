# Chrome Coupon Tester Extension

## Problem
Build a Chrome extension to test coupon codes on any e-commerce site using a local ollama LLM as the AI agent.

## Tech Stack
- TypeScript (compiled with tsc, separate tsconfig for content script to avoid ES module shim)
- Chrome Extension Manifest V3
- i18n: English + Portuguese
- Local log server (log-server.py → extension.log)

## Architecture

### Entry Points
- `src/popup.ts` — UI: model selector, store name override, Build Plan / Collect Coupons / Test Coupons buttons, live status, stop button, feedback row, notes, history, saved plans
- `src/background.ts` — Service worker: dual-run plan-building loop, Pelando coupon collection, batch coupon testing, plan generation, routes tool calls to content script via port
- `src/content.ts` — Injected into pages: DOM tools implementation
- `src/logger.ts` — Patches `console.log/warn/error` to forward to local log server

### Build
- `tsconfig.json` — compiles popup, background, logger (ES2020 modules)
- `tsconfig.content.json` — compiles content.ts as CommonJS (no `export {}` shim that breaks content scripts)

### Log Server
- `log-server.py` — HTTP server on port 7777, writes to `extension.log`
- Start with: `python3 log-server.py`

## AI Agent Tools (background ↔ content)

| Tool | Description |
|---|---|
| `get_page_info` | Scans all frames (main + iframes) for inputs, buttons, coupon-related links. Tags elements with `data-ai-idx`. Returns `frameIdx:selector` format. |
| `fill_input` | Fills an input, fires input/change/keydown/keyup/blur events for React/Vue/Angular compatibility. Resolves `frameIdx:selector`. |
| `click_element` | Clicks element, scrolls into view, waits 2s for DOM updates. |
| `get_page_text` | Returns visible text from all frames (capped 1.5KB/frame). |
| `query_dom` | Arbitrary CSS selector query returning outerHTML snippets, searches all frames. Supports both plain and `frameIdx:selector` encoded format. |
| `SCRAPE_PELANDO_STORE_LINKS` | Scrapes Pelando store listing links including slug + visible store name to resolve the right coupon page dynamically. |
| `SCRAPE_PELANDO_COUPONS` | Scrapes Pelando coupon pages for `data-masked` codes and visible coupon text. |

## Key Decisions & Fixes Made

### Content Script Module Issue
- Content scripts cannot be ES modules — tsc would emit `export {}` crashing the script
- Fix: separate `tsconfig.content.json` with `"module": "CommonJS"`
- Also removed all `import` statements from content.ts (types inlined)

### Ollama CORS (HTTP 403)
- Ollama blocks chrome-extension:// origin by default
- Fix: `Environment="OLLAMA_ORIGINS=*"` in `/etc/systemd/system/ollama.service.d/override.conf`

### Content Script Not Injected
- Pages opened before extension loads don't have content script
- Fix: `ensureContentScript()` pings on startup and throws a clear error if not active

### Link Detection (wrong element selected)
- Filter was keeping ancestor elements instead of innermost clickable element
- Fix: `.filter((el, _i, arr) => !arr.some((other) => other !== el && el.contains(other)))`

### Iframe Support
- Mercado Livre renders coupon modal in an iframe — `document.querySelectorAll` misses it
- Fix: `getAccessibleDocs()` iterates main doc + all same-origin iframes
- Selectors encoded as `"frameIdx:cssSelector"` so fill/click resolve to the right frame

### Disabled Button Pattern
- "Adicionar cupom" button starts disabled, enables after typing in the input
- Fix: `disabled` field exposed in button info; model told to fill first then click
- `fill_input` fires keydown/keyup in addition to input/change

### Result Classification
- 3 states: `success` (coupon accepted), `rejected` (store rejected it — invalid/expired), `error` (automation failed / couldn't determine outcome)
- Explicit `RESULT: success/rejected/error` verdict required at end of model response
- Fallback keyword heuristic separates rejection signals from outright failure

### query_dom Encoded Selector Fix
- AI passes `frameIdx:selector` encoded strings to query_dom, but raw CSS selector was being passed to `querySelectorAll` → crash
- Fix: strip `frameIdx:` prefix before querying, target only the matching frame

### Amazon Apply Button
- AI was clicking placeOrder/confirm-order buttons instead of the small "Aplicar" button next to the input
- Fix: prompt explicitly forbids clicking order-confirmation buttons; instructs AI to re-call `get_page_info` after filling (button appears reactively); use `query_dom` with sibling selectors (e.g. `input[name="ppw-claimCode"] ~ button`) to find the adjacent apply button

### Toast / Snackbar Result Detection
- Some stores surface coupon validation only via toast/snackbar/alert instead of inline error text
- Fix: `get_page_text()` now also includes `[role='alert']`, `[aria-live]`, and toast/snackbar-like containers so the model can classify the result correctly

## Phase 3 Features Added

### 3-Button Workflow
- `Build Plan` replaces the old generic test-run action
- `Collect Coupons` scrapes coupons from Pelando for the current store
- `Test Coupons` iterates through collected coupons using the saved plan and updates each coupon entry with its result

### Dynamic Pelando Store Resolution
- Coupon collection starts from `https://www.pelando.com.br/cupons-de-descontos`
- The extension scrapes Pelando's own store links and resolves the best match dynamically instead of hardcoding site slugs
- Matching uses both Pelando slug and visible store name

### Editable Store Name Override
- Popup now includes a `Store Name` input persisted per hostname
- Used to override Pelando matching when the real brand name differs from Pelando naming, e.g. `Magazine Luiza` -> `magalu`
- After collection, the input is updated with the actual Pelando store name that was matched so mismatches are visible immediately

### Coupon Collection
- Opens Pelando pages in a hidden tab and scrapes real DOM content instead of using background `fetch`, which was blocked by Cloudflare/HTTP 403
- Extracts coupons from both `data-masked` attributes and visible coupon text
- Saves collected coupons into the per-site history with empty status, ready for testing

### Batch Coupon Testing
- `Test Coupons` only processes collected coupons with empty status
- Uses the saved execution plan for the current hostname
- Persists each coupon result immediately as it is tested
- Pushes live per-coupon updates back to the popup while the batch is running

### Stop / Resume Behavior
- Popup now has a stop button next to the status message
- Stopping collection or testing interrupts the current operation cleanly
- If batch testing is interrupted, the in-flight coupon stays pending (empty status) so a later run can resume from it

### Failure Reasons + Hover Tooltip
- Rejected/error coupons now persist a `reason`
- Popup shows a custom hover tooltip on failed badges so the stored failure reason is visible in the coupon list

### Synthetic Plan Codes Excluded From History
- Build-plan random `TESTxxxxxx` coupons are no longer saved into the normal coupon history
- Prevents collected real coupons from being mixed with temporary plan-building probes

## Phase 2 Features Added

### Removed Manual Coupon Input
- Coupon codes are now auto-generated (`TEST` + 6 random alphanumeric chars)
- Two different codes generated per session (one per run)

### Plan Building vs Real Coupon Testing
- `Build Plan` still performs the dual-run repeatability check with two synthetic coupon codes
- `Test Coupons` does not do dual-run checks; it tests each real collected coupon once using the saved plan

### Per-Website History
- History keyed by `coupon_history_<hostname>` — only entries for the active site shown/cleared

### Remember Last Selected Model
- Persisted to `chrome.storage.local` under `last_model`, restored on popup open

### Execution Feedback UI
- After every run: "Was this execution correct? 👍 👎"
- 👍 → triggers AI plan generation
- 👎 → shows notes textarea for user to describe what went wrong

### Correction Notes
- User's 👎 explanation saved to `chrome.storage.session` under `correction_notes_<hostname>`
- Injected into system prompt on next run; cleared after use
- On `error` result, notes textarea opens automatically

### AI-Generated Execution Plans
- On 👍, background sends full conversation + plan-generation prompt to ollama
- Plan saved to `chrome.storage.local` under `execution_plans_<hostname>`
- On subsequent runs, saved plan is injected into system prompt (skips free-form exploration)

### Plans Management UI
- "Saved Plans" section per website: preview (expandable), date, per-entry delete button, "Clear all"

### Dual-Run Repeatability
- Every TEST RUN executes two independent AI passes with different random coupon codes
- If run 1 errors, run 2 is skipped
- Inconsistent results (run1 ≠ run2) shown as warning; notes textarea opens automatically
- Plan generation prompt includes inconsistency note when runs disagreed

### Popup State Persistence
- `chrome.storage.session` persists status text/level and feedback visibility across popup closes
- On reopen: restores last status and reconnects port if a session is still running in background

### Live Batch Progress
- During `Test Coupons`, popup status updates after each completed coupon instead of waiting for the whole batch to finish
- History refreshes incrementally as results are saved

### Plan Includes Inconsistency Notes
- When the two runs disagreed, the AI-generated plan includes a dedicated section on what caused the inconsistency and how to handle it robustly

## Workplan
- [x] Project setup (package.json, tsconfig.json, manifest.json)
- [x] i18n (en + pt)
- [x] Popup UI (model dropdown, TEST RUN button, status, feedback, notes, history, plans)
- [x] Per-site history (`coupon_history_<hostname>`)
- [x] Remember last selected model
- [x] Log server (log-server.py) + console forwarder (logger.ts)
- [x] Background service worker with dual-run ollama tool-calling loop
- [x] Content script DOM tools (get_page_info, fill_input, click_element, get_page_text, query_dom)
- [x] Iframe support in all tools
- [x] Live status updates via chrome.runtime port
- [x] 3-state result classification (success / rejected / error)
- [x] Popup state persistence across closes (chrome.storage.session)
- [x] Execution feedback (👍/👎) + correction notes
- [x] AI plan generation + per-site plan management UI
- [x] Dual-run repeatability with inconsistency detection
- [x] query_dom encoded selector fix
- [x] Amazon apply button prompt fix (proximity, no placeOrder)
- [x] Replace TEST RUN with Build Plan / Collect Coupons / Test Coupons workflow
- [x] Dynamic Pelando store resolution from the store listing page
- [x] Editable per-site store name override
- [x] Hidden-tab Pelando scraping for coupon collection
- [x] Batch testing of collected coupons using saved plan
- [x] Stop button for collection/testing sessions
- [x] Keep in-flight coupon pending when batch testing is interrupted
- [x] Save failure reasons and show them in hover tooltips
- [x] Include toast/snackbar/alert text in result detection
- [x] Live incremental history updates during batch testing

## What Works
- Mercado Livre: clicks toggle link, fills iframe input, clicks "Adicionar cupom", reports correct result
- Amazon BR: finds coupon input, uses query_dom sibling selectors to locate "Aplicar" button, reads outcome message
- Pelando collection: resolves the correct Pelando coupon page dynamically from the master store list and scrapes hidden/visible coupon codes
- Brand alias override: user can correct Pelando naming mismatches via the `Store Name` field
- Batch testing: runs through pending collected coupons, saves each result immediately, and resumes cleanly after interruption
- Generic — no site-specific hardcoding, works through LLM reasoning + saved plans

## Next Steps (Phase 3 ideas)
- [ ] Test on other e-commerce sites (Shopify stores, etc.)
- [ ] Auto-scroll to reveal hidden elements
- [ ] Support multi-step coupon flows (login required, etc.)
- [ ] Surface discount amount from page text when successful
- [ ] Export/import saved plans across devices
- [ ] Add a smarter alias dictionary / fuzzy ranking layer for difficult brand-name mismatches beyond manual override
