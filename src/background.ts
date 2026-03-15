import type {
  RunAiMessage,
  GeneratePlanMessage,
  CollectCouponsMessage,
  TestCouponsMessage,
  StopSessionMessage,
  PageInfo,
  PortMessage,
  CouponResult,
  ExecutionPlan,
  HistoryEntry,
} from "./types.js";
import { installConsoleForwarder } from "./logger.js";
installConsoleForwarder("background");

const OLLAMA_URL = "http://localhost:11434";
const MAX_ITERATIONS = 24;
const MAX_HISTORY = 200;
const PELANDO_BASE_URL = "https://www.pelando.com.br/cupons-de-descontos";
const PELANDO_LIST_URL = "https://www.pelando.com.br/cupons-de-descontos";

// ── Tool definitions sent to ollama ──────────────────────────────────────

const TOOLS = [
  {
    type: "function",
    function: {
      name: "query_dom",
      description: "Run an arbitrary CSS selector query and return the outerHTML of matching elements. Use this to investigate the DOM structure around a specific area, e.g. after clicking a toggle to understand why an input isn't appearing.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "Any valid CSS selector" },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_coupon_inputs",
      description:
        "Scans the entire DOM for all text inputs, including hidden ones. Use this after clicking a toggle link if get_page_info still shows no coupon field — the input may exist but be hidden or off-screen.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_info",
      description:
        "Returns all visible input fields, buttons, and coupon-related links on the current page, each with a unique CSS selector you can use in other tools. Always call this first, and call it again after clicking a toggle link to reveal hidden fields.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "fill_input",
      description: "Types a value into an input field identified by its CSS selector.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector from get_page_info" },
          value:    { type: "string", description: "Text to type into the field" },
        },
        required: ["selector", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "click_element",
      description: "Clicks a button or element identified by its CSS selector.",
      parameters: {
        type: "object",
        properties: {
          selector: { type: "string", description: "CSS selector from get_page_info" },
        },
        required: ["selector"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_page_text",
      description:
        "Returns visible text from the page. Use this after clicking apply to check for a discount confirmation or error message.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
];

// ── Port (live status → popup) ────────────────────────────────────────────

let activePort: chrome.runtime.Port | null = null;
let lastMessages: OllamaMsg[] = [];
let lastInconsistency: { run1: CouponResult; run2: CouponResult } | null = null;
let stopRequested = false;

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "ai-session") return;
  activePort = port;
  port.onDisconnect.addListener(() => {
    if (activePort === port) activePort = null;
  });
});

function postStatus(message: string, level: StatusUpdate["level"] = "info"): void {
  console.log(`[Coupon Tester BG] [${level}] ${message}`);
  activePort?.postMessage({ type: "STATUS", message, level } as PortMessage);
}

function postDone(result: CouponResult, code: string, code2: string | undefined, planUsed: boolean, inconsistent: boolean, run1Result?: CouponResult, reason?: string, reason2?: string): void {
  console.log(`[Coupon Tester BG] Done — result: ${result}, code: ${code}, code2: ${code2}, planUsed: ${planUsed}, inconsistent: ${inconsistent}`);
  chrome.storage.session.set({ session_running: false });
  activePort?.postMessage({ type: "DONE", result, code, code2, reason, reason2, planUsed, inconsistent, run1Result } as PortMessage);
}

function postBatchDone(tested: number, good: number, bad: number, errors: number): void {
  console.log(`[Coupon Tester BG] Batch done — tested: ${tested}, good: ${good}, bad: ${bad}, errors: ${errors}`);
  chrome.storage.session.set({ session_running: false });
  activePort?.postMessage({ type: "BATCH_DONE", tested, good, bad, errors } as PortMessage);
}

// ── Ensure content script is injected ────────────────────────────────────

async function ensureContentScript(tabId: number): Promise<void> {
  // Check the tab URL first — content scripts can't run on restricted pages
  const tab = await chrome.tabs.get(tabId);
  console.log("[Coupon Tester BG] Active tab URL:", tab.url);

  if (!tab.url || /^(chrome|chrome-extension|about|data):/.test(tab.url)) {
    throw new Error(`Content scripts cannot run on this page: ${tab.url}`);
  }

  try {
    await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_TEXT" });
    console.log("[Coupon Tester BG] Content script ping OK");
  } catch (err) {
    console.error("[Coupon Tester BG] Content script ping failed:", err);
    throw new Error("Content script not active — please refresh the page then try again.");
  }
}

// ── Route tool calls to content script ───────────────────────────────────

async function execTool(
  tabId: number,
  name: string,
  args: Record<string, string>
): Promise<string> {
  switch (name) {
    case "query_dom": {
      const result = await chrome.tabs.sendMessage(tabId, { type: "QUERY_DOM", selector: args.selector });
      return JSON.stringify(result, null, 2);
    }
    case "get_coupon_inputs": {
      const inputs = await chrome.tabs.sendMessage(tabId, { type: "GET_COUPON_INPUTS" });
      return JSON.stringify(inputs, null, 2);
    }
    case "get_page_info": {
      const info: PageInfo = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_INFO" });
      return JSON.stringify(info, null, 2);
    }
    case "fill_input": {
      await chrome.tabs.sendMessage(tabId, {
        type: "FILL_INPUT",
        selector: args.selector,
        value: args.value,
      });
      return `Filled "${args.selector}" with value "${args.value}".`;
    }
    case "click_element": {
      await chrome.tabs.sendMessage(tabId, {
        type: "CLICK_ELEMENT",
        selector: args.selector,
      });
      return `Clicked "${args.selector}".`;
    }
    case "get_page_text": {
      const text: string = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_TEXT" });
      return text;
    }
    default:
      return `Unknown tool: ${name}`;
  }
}

// ── Ollama conversation types ─────────────────────────────────────────────

interface OllamaMsg {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: Record<string, string> } }>;
}

// ── Single AI pass ────────────────────────────────────────────────────────

async function runSinglePass(
  model: string,
  couponCode: string,
  tabId: number,
  systemPrompt: string,
  runLabel: string,
): Promise<{ result: CouponResult; messages: OllamaMsg[]; reason?: string }> {
  const messages: OllamaMsg[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: `Please apply the coupon code "${couponCode}" on the current page.` },
  ];

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    if (stopRequested) {
      postStatus(`${runLabel} Stopped by user.`, "warning");
      return { result: "error", messages, reason: "Stopped by user." };
    }

    postStatus(`${runLabel} Step ${i + 1} — asking model…`);

    const res = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools: TOOLS, stream: false }),
    });

    if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

    const data = await res.json();
    const assistantMsg: OllamaMsg = data.message;
    messages.push(assistantMsg);

    console.log(`[Coupon Tester BG] ${runLabel} assistant →`, JSON.stringify(assistantMsg, null, 2));

    if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
      const text = assistantMsg.content?.toLowerCase() ?? "";
      const reason = assistantMsg.content?.trim();
      let result: CouponResult;
      if (text.includes("result: success")) {
        result = "success";
      } else if (text.includes("result: rejected")) {
        result = "rejected";
      } else if (text.includes("result: error")) {
        result = "error";
      } else {
        const rejected =
          text.includes("invalid") || text.includes("inválido") ||
          text.includes("not valid") || text.includes("não válido") ||
          text.includes("rejected") || text.includes("rejeitado") ||
          text.includes("not accepted") || text.includes("não aceito") ||
          text.includes("not applicable") || text.includes("expired") ||
          text.includes("expirado") || text.includes("unsuccessful") ||
          text.includes("coupon not found") || text.includes("cupão não encontrado");

        const succeeded = (
          text.includes("success") || text.includes("sucesso") ||
          text.includes("applied") || text.includes("aplicado") ||
          text.includes("discount applied") || text.includes("desconto aplicado") ||
          text.includes("valid") || text.includes("válido")
        ) && !rejected;

        result = succeeded ? "success" : rejected ? "rejected" : "error";
      }

      const level = result === "success" ? "success" : result === "rejected" ? "warning" : "error";
      postStatus(`${runLabel} ${assistantMsg.content || "Done."}`, level);
      return { result, messages, reason };
    }

    for (const toolCall of assistantMsg.tool_calls) {
      if (stopRequested) {
        postStatus(`${runLabel} Stopped by user.`, "warning");
        return { result: "error", messages, reason: "Stopped by user." };
      }
      const { name, arguments: args } = toolCall.function;
      postStatus(`${runLabel} Tool: ${name}${args?.selector ? ` → ${args.selector}` : ""}`);
      try {
        const toolResult = await execTool(tabId, name, args ?? {});
        console.log(`[Coupon Tester BG] ${runLabel} tool ${name} ←`, toolResult.slice(0, 200));
        messages.push({ role: "tool", content: toolResult });
      } catch (err) {
        const errText = `Error in tool "${name}": ${String(err)}`;
        console.error("[Coupon Tester BG]", errText);
        messages.push({ role: "tool", content: errText });
      }
    }
  }

  postStatus(`${runLabel} Reached max steps without a definitive answer.`, "warning");
  return { result: "error", messages, reason: "Reached max steps without definitive result." };
}

// ── Main AI session ───────────────────────────────────────────────────────

async function runAiSession(msg: RunAiMessage): Promise<void> {
  const { model, couponCode, couponCode2, tabId, hostname, correctionNotes } = msg;

  stopRequested = false;
  chrome.storage.session.set({ session_running: true });
  postStatus(`Starting session with model "${model}"…`);

  await ensureContentScript(tabId);

  // Look up any saved execution plan for this site
  const planStorageKey = `${PLANS_KEY_PREFIX}${hostname}`;
  const planData = await chrome.storage.local.get(planStorageKey);
  const savedPlans: ExecutionPlan[] = (planData[planStorageKey] as ExecutionPlan[]) ?? [];
  const planUsed = savedPlans.length > 0;

  const correctionBlock = correctionNotes
    ? `\n\nIMPORTANT — the user flagged the previous run as incorrect and left this note:\n"${correctionNotes}"\nTake this into account and try a different approach if needed.`
    : "";

  const systemPrompt = planUsed
    ? `You are a browser automation assistant helping test coupon codes on e-commerce websites.

Selectors use the format "frameIdx:cssSelector" — always pass them as-is to fill_input and click_element.
Buttons have a "disabled" field — fill the input first, then click the apply button (it may become enabled after filling).

You have a previously verified execution plan for this website. Follow it closely:

--- SAVED PLAN ---
${savedPlans[0].plan}
--- END PLAN ---

Tips:
- The plan's selectors and steps were confirmed to work. Follow them, but adapt if minor page details differ (e.g. error message wording).
- Be concise and act — don't ask for confirmation.
- NEVER click buttons that place/confirm an order (e.g. id "placeOrder", text "Confirmar pedido", "Place order").
- End your final message with exactly one of: "RESULT: success", "RESULT: rejected", or "RESULT: error".
  Use "RESULT: success" when the coupon was accepted and a discount was applied.
  Use "RESULT: rejected" when the coupon was submitted but the store rejected it (invalid, expired, not applicable).
  Use "RESULT: error" when you could not complete the automation or determine the outcome.${correctionBlock}`
    : `You are a browser automation assistant helping test coupon codes on e-commerce websites.

Selectors use the format "frameIdx:cssSelector" — always pass them as-is to fill_input and click_element.

Your job:
1. Call get_page_info. It scans all frames including iframes. Check inputs, buttons, and links.
2. If you see a coupon-related link (e.g. "Inserir cupom", "Usar cupom", "Have a gift card?"), click it, then call get_page_info again to reveal the hidden input.
3. Find the coupon input (by placeholder, name, id, label, or class — look for "cupom", "coupon", "claimCode", "voucher", "Digitar código"). Fill it with fill_input.
4. After filling, call get_page_info again — a dedicated apply button often appears only after the field has a value.
5. Find the apply button **closest to the coupon input in the DOM** — it is almost always an immediate sibling or inside the same parent container as the input. Use query_dom on the input's parent or siblings (e.g. \`frameIdx:input[name="ppw-claimCode"] ~ button\`, or \`frameIdx:.coupon-row button\`) to locate it precisely. Look for text "Aplicar", "Adicionar", "Apply", "Redeem". Click it.
6. Call get_page_text to read the outcome message, then call get_page_info to check for any remaining visible confirmation/error near the coupon area.
7. Report the outcome.

Critical rules:
- NEVER click buttons that place or confirm the order (e.g. id "placeOrder", text "Confirmar pedido", "Fazer pedido", "Place your order", "Submit order"). Those are purchase buttons, not coupon apply buttons.
- The coupon apply button is always small and located directly next to the coupon input field — it is NOT the main checkout/confirm button.
- If the apply button is still disabled after filling, dispatch an input event first (fill_input already does this). If still disabled, try using query_dom to inspect the button's HTML.
- Use query_dom to inspect HTML around the coupon input when get_page_info doesn't show the apply button.
- Coupon fields and their buttons are often in iframes — check frameIdx in results.
- After clicking apply, wait for get_page_text to show a result message (success or error). Look for phrases like "aplicado", "desconto", "inválido", "não encontrado", "applied", "invalid", "not found".
- Some stores show only a toast/snackbar/alert instead of inline error text. Always check toast/alert/live regions using get_page_text and query_dom (e.g. [role='alert'], [aria-live], classes containing toast/snackbar).
- Be concise and act — don't ask for confirmation.
- End your final message with exactly one of: "RESULT: success", "RESULT: rejected", or "RESULT: error".
  Use "RESULT: success" when the coupon was accepted and a discount was applied.
  Use "RESULT: rejected" when the coupon was submitted but the store rejected it (invalid, expired, not applicable).
  Use "RESULT: error" when you could not complete the automation or determine the outcome.${correctionBlock}`;

  postStatus("Run 1/2 — starting…");
  const pass1 = await runSinglePass(model, couponCode, tabId, systemPrompt, "[1/2]");

  // Skip run 2 if run 1 failed to complete automation — no point repeating a broken run
  if (pass1.result === "error") {
    lastMessages = pass1.messages;
    lastInconsistency = null;
    postDone(pass1.result, couponCode, undefined, planUsed, false, undefined, pass1.reason, undefined);
    return;
  }

  if (stopRequested) {
    postDone("error", couponCode, undefined, planUsed, false, undefined, "Stopped by user.", undefined);
    return;
  }

  postStatus("Run 2/2 — starting…");
  const pass2 = await runSinglePass(model, couponCode2, tabId, systemPrompt, "[2/2]");

  const inconsistent = pass1.result !== pass2.result;
  lastMessages = pass2.messages;
  lastInconsistency = inconsistent ? { run1: pass1.result, run2: pass2.result } : null;

  if (inconsistent) {
    postStatus(
      `Results inconsistent — Run 1: ${pass1.result}, Run 2: ${pass2.result}`,
      "warning",
    );
  }

  postDone(pass2.result, couponCode, couponCode2, planUsed, inconsistent, pass1.result, pass2.reason, pass1.reason);
}

async function runCouponBatch(msg: TestCouponsMessage): Promise<void> {
  const { model, tabId, hostname } = msg;
  stopRequested = false;
  chrome.storage.session.set({ session_running: true });

  await ensureContentScript(tabId);

  const planStorageKey = `${PLANS_KEY_PREFIX}${hostname}`;
  const planData = await chrome.storage.local.get(planStorageKey);
  const savedPlans: ExecutionPlan[] = (planData[planStorageKey] as ExecutionPlan[]) ?? [];
  if (savedPlans.length === 0) {
    throw new Error("No saved plan for this website. Build a plan first.");
  }

  const historyStorageKey = `coupon_history_${hostname}`;
  const existingData = await chrome.storage.local.get(historyStorageKey);
  const history = (existingData[historyStorageKey] as HistoryEntry[]) ?? [];
  const pending = history.filter((h) => h.result === undefined);
  if (pending.length === 0) {
    postBatchDone(0, 0, 0, 0);
    return;
  }

  const systemPrompt = `You are a browser automation assistant helping test coupon codes on e-commerce websites.

Selectors use the format "frameIdx:cssSelector" — always pass them as-is to fill_input and click_element.
Buttons have a "disabled" field — fill the input first, then click the apply button (it may become enabled after filling).

Use this verified execution plan for this website:

--- SAVED PLAN ---
${savedPlans[0].plan}
--- END PLAN ---

Rules:
- Follow the plan strictly and adapt only if the page changed slightly.
- NEVER click buttons that place/confirm an order.
- Some stores only show toast/snackbar/alert feedback; inspect get_page_text and query_dom for [role='alert'], [aria-live], toast/snackbar containers.
- End your final message with exactly one of: "RESULT: success", "RESULT: rejected", or "RESULT: error".
  Use "RESULT: success" when coupon accepted with discount.
  Use "RESULT: rejected" when coupon submitted but rejected by store.
  Use "RESULT: error" when you cannot complete automation or determine result.`;

  let good = 0;
  let bad = 0;
  let errors = 0;

  for (let i = 0; i < pending.length; i++) {
    if (stopRequested) {
      postStatus("Coupon batch stopped by user.", "warning");
      break;
    }

    const code = pending[i].code;
    postStatus(`Testing coupon ${i + 1}/${pending.length}: ${code}`, "info");

    const pass = await runSinglePass(model, code, tabId, systemPrompt, `[TEST ${i + 1}/${pending.length}]`);
    const result = pass.result;

    if (result === "success") good += 1;
    else if (result === "rejected") bad += 1;
    else errors += 1;

    for (const entry of history) {
      if (entry.code === code) {
        entry.result = result;
        if (result === "rejected" || result === "error") {
          entry.reason = pass.reason;
        } else {
          delete entry.reason;
        }
        break;
      }
    }
    await chrome.storage.local.set({ [historyStorageKey]: history.slice(0, MAX_HISTORY) });
  }

  postBatchDone(pending.length, good, bad, errors);
}

// ── Plan generation ───────────────────────────────────────────────────────

const PLANS_KEY_PREFIX = "execution_plans_";

async function generatePlan(msg: GeneratePlanMessage): Promise<void> {
  const { model, hostname } = msg;

  if (lastMessages.length === 0) {
    postStatus("No recent session to generate a plan from.", "warning");
    return;
  }

  postStatus("Generating execution plan…", "info");

  const inconsistencyNote = lastInconsistency
    ? `\n\nIMPORTANT REPEATABILITY NOTE: The two test runs produced different results. ` +
      `Run 1 gave "${lastInconsistency.run1}" and Run 2 gave "${lastInconsistency.run2}". ` +
      `Please include a section in the plan noting this inconsistency and what might cause it ` +
      `(e.g. timing, page state, animations, async loading). Suggest how to handle it robustly.`
    : "";

  const planMessages: OllamaMsg[] = [
    ...lastMessages,
    {
      role: "user",
      content:
        "Great, the execution was successful. Please write a detailed technical plan describing exactly what you did to apply the coupon: " +
        "which selectors you used, which steps you took, in what order, and why each step was necessary. " +
        "Be specific about element selectors and interaction sequence. " +
        "Keep some flexibility for dynamic content like error/success messages that may vary. " +
        `Format the plan as a numbered step-by-step guide.${inconsistencyNote}`,
    },
  ];

  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: planMessages, stream: false }),
  });

  if (!res.ok) throw new Error(`Ollama returned HTTP ${res.status}`);

  const data = await res.json();
  const planText: string = data.message?.content ?? "";

  const storageKey = `${PLANS_KEY_PREFIX}${hostname}`;
  const existing = await chrome.storage.local.get(storageKey);
  const plans: ExecutionPlan[] = (existing[storageKey] as ExecutionPlan[]) ?? [];
  const newPlan: ExecutionPlan = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    plan: planText,
  };
  plans.unshift(newPlan);
  await chrome.storage.local.set({ [storageKey]: plans });

  postStatus("Plan saved!", "success");
  activePort?.postMessage({ type: "PLAN_SAVED" });
}

// ── Coupon collection (Phase 3) ─────────────────────────────────────────

function normalizePelandoSlug(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.(com|com\.br|net|org|store|shop|io|co|biz|info)$/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function waitForTabComplete(tabId: number, timeoutMs = 20000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error(`Timed out waiting for Pelando tab load (${timeoutMs}ms).`));
    }, timeoutMs);

    const listener = (updatedTabId: number, info: chrome.tabs.TabChangeInfo): void => {
      if (updatedTabId !== tabId) return;
      if (info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

interface PelandoScrapeResponse {
  codes: string[];
  title: string;
  url: string;
}

interface PelandoStoreLinksResponse {
  links: string[];
  title: string;
  url: string;
}

function normalizeHostBase(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/^www\./, "")
    .replace(/\.(com|com\.br|net|org|store|shop|io|co|biz|info)$/g, "");
}

function normalizeSlugKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function withHiddenTab<T>(url: string, fn: (tabId: number) => Promise<T>): Promise<T> {
  const tab = await chrome.tabs.create({ url, active: false });
  if (!tab.id) throw new Error(`Could not open tab for ${url}`);

  const tabId = tab.id;
  try {
    await waitForTabComplete(tabId);
    await new Promise((r) => setTimeout(r, 1200));
    return await fn(tabId);
  } finally {
    try { await chrome.tabs.remove(tabId); } catch { /* ignore */ }
  }
}

async function resolvePelandoStoreUrl(hostname: string): Promise<string> {
  const fallback = `${PELANDO_BASE_URL}/${normalizePelandoSlug(hostname)}`;
  const targetKey = normalizeSlugKey(normalizeHostBase(hostname));

  try {
    const response = await withHiddenTab(PELANDO_LIST_URL, async (tabId) => {
      return await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_PELANDO_STORE_LINKS" }) as PelandoStoreLinksResponse;
    });

    const links = response?.links ?? [];
    if (links.length === 0) return fallback;

    let best: { url: string; score: number } | null = null;
    for (const link of links) {
      let slug = "";
      try {
        const u = new URL(link);
        slug = u.pathname.replace(/^\/cupons-de-descontos\/?/, "").replace(/\/$/, "");
      } catch {
        continue;
      }
      if (!slug) continue;

      const key = normalizeSlugKey(slug);
      let score = 0;
      if (key === targetKey) score = 100;
      else if (key.includes(targetKey) || targetKey.includes(key)) score = 80;
      else {
        const prefixLen = [...key].findIndex((ch, i) => ch !== targetKey[i]);
        score = prefixLen === -1 ? Math.min(key.length, targetKey.length) : prefixLen;
      }

      if (!best || score > best.score) {
        best = { url: link, score };
      }
    }

    if (best && best.score >= 80) {
      return best.url;
    }
  } catch (err) {
    console.warn("[Coupon Tester BG] Failed to resolve Pelando store URL from list:", err);
  }

  return fallback;
}

async function collectCouponsFromPelandoPage(sourceUrl: string): Promise<string[]> {
  return withHiddenTab(sourceUrl, async (tabId) => {
    const response = await chrome.tabs.sendMessage(tabId, { type: "SCRAPE_PELANDO_COUPONS" }) as PelandoScrapeResponse;
    if (!response || !Array.isArray(response.codes)) {
      throw new Error("Could not read coupon data from Pelando page.");
    }
    return response.codes;
  });
}

async function collectCoupons(msg: CollectCouponsMessage): Promise<{ added: number; totalFound: number; sourceUrl: string }> {
  const { hostname } = msg;
  stopRequested = false;
  const sourceUrl = await resolvePelandoStoreUrl(hostname);

  postStatus(`Collecting coupons from Pelando for ${hostname} (${sourceUrl})…`, "info");

  if (stopRequested) {
    throw new Error("Stopped by user.");
  }

  const codes = await collectCouponsFromPelandoPage(sourceUrl);
  if (stopRequested) {
    throw new Error("Stopped by user.");
  }
  if (codes.length === 0) {
    return { added: 0, totalFound: 0, sourceUrl };
  }

  const historyStorageKey = `coupon_history_${hostname}`;
  const existingData = await chrome.storage.local.get(historyStorageKey);
  const existing = (existingData[historyStorageKey] as HistoryEntry[]) ?? [];

  const byCode = new Map<string, HistoryEntry>();
  for (const entry of existing) {
    byCode.set(entry.code.toUpperCase(), entry);
  }

  let added = 0;
  for (const code of codes) {
    if (!byCode.has(code)) {
      byCode.set(code, { code });
      added += 1;
    }
  }

  const merged = Array.from(byCode.values());
  merged.sort((a, b) => {
    const aPending = a.result === undefined;
    const bPending = b.result === undefined;
    if (aPending !== bPending) return aPending ? -1 : 1;
    return a.code.localeCompare(b.code);
  });

  await chrome.storage.local.set({ [historyStorageKey]: merged.slice(0, MAX_HISTORY) });
  return { added, totalFound: codes.length, sourceUrl };
}

// ── Entry point ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message: RunAiMessage | GeneratePlanMessage | CollectCouponsMessage | TestCouponsMessage | StopSessionMessage, _sender, sendResponse) => {
  if (message.type === "RUN_AI") {
    runAiSession(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[Coupon Tester BG]", err);
        postStatus(`Error: ${String(err)}`, "error");
        postDone("error", (message as RunAiMessage).couponCode, undefined, false, false);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "GENERATE_PLAN") {
    generatePlan(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[Coupon Tester BG]", err);
        postStatus(`Error generating plan: ${String(err)}`, "error");
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "COLLECT_COUPONS") {
    collectCoupons(message)
      .then((result) => {
        postStatus(`Collection complete: ${result.added} new of ${result.totalFound} found.`, "success");
        sendResponse({ ok: true, ...result });
      })
      .catch((err) => {
        const errText = String(err);
        console.error("[Coupon Tester BG]", err);
        postStatus(`Collection failed: ${errText}`, "error");
        sendResponse({ ok: false, error: errText });
      });
    return true;
  }

  if (message.type === "TEST_COUPONS") {
    runCouponBatch(message)
      .then(() => sendResponse({ ok: true }))
      .catch((err) => {
        console.error("[Coupon Tester BG]", err);
        chrome.storage.session.set({ session_running: false });
        postStatus(`Coupon testing failed: ${String(err)}`, "error");
        postBatchDone(0, 0, 0, 1);
        sendResponse({ ok: false, error: String(err) });
      });
    return true;
  }

  if (message.type === "STOP_SESSION") {
    stopRequested = true;
    postStatus("Stopping current operation...", "warning");
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.runtime.onInstalled.addListener(() => {
  console.log("[Coupon Tester] Extension installed.");
});

// helper type (referenced but not imported from types.ts to avoid circular issues)
interface StatusUpdate { level: "info" | "success" | "error" | "warning" }
