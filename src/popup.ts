import type { CouponResult, ExecutionPlan, PortMessage } from "./types.js";
import { installConsoleForwarder } from "./logger.js";
installConsoleForwarder("popup");

const i18n = chrome.i18n.getMessage.bind(chrome.i18n);

const statusEl       = document.getElementById("status")          as HTMLDivElement;
const historyList    = document.getElementById("history-list")    as HTMLUListElement;
const historySection = document.getElementById("history-section") as HTMLElement;
const clearBtn       = document.getElementById("clear-btn")       as HTMLButtonElement;
const ollamaBtn      = document.getElementById("ollama-btn")      as HTMLButtonElement;
const collectBtn     = document.getElementById("collect-btn")     as HTMLButtonElement;
const testBtn        = document.getElementById("test-btn")        as HTMLButtonElement;
const stopBtn        = document.getElementById("stop-btn")        as HTMLButtonElement;
const modelSelect    = document.getElementById("model-select")    as HTMLSelectElement;
const modelStatus    = document.getElementById("model-status")    as HTMLDivElement;
const feedbackRow    = document.getElementById("feedback-row")    as HTMLDivElement;
const feedbackGood   = document.getElementById("feedback-good")   as HTMLButtonElement;
const feedbackBad    = document.getElementById("feedback-bad")    as HTMLButtonElement;
const notesRow       = document.getElementById("notes-row")       as HTMLDivElement;
const notesInput     = document.getElementById("notes-input")     as HTMLTextAreaElement;
const notesSubmit    = document.getElementById("notes-submit")    as HTMLButtonElement;
const plansSection   = document.getElementById("plans-section")   as HTMLElement;
const plansList      = document.getElementById("plans-list")      as HTMLUListElement;
const clearPlansBtn  = document.getElementById("clear-plans-btn") as HTMLButtonElement;

// i18n
document.getElementById("ext-name")!.textContent       = i18n("extName");
document.getElementById("history-title")!.textContent  = i18n("historyTitle");
document.getElementById("feedback-label")!.textContent = i18n("feedbackLabel");
document.getElementById("notes-label")!.textContent    = i18n("notesLabel");
document.getElementById("plans-title")!.textContent    = i18n("plansTitle");
clearBtn.textContent      = i18n("clearHistory");
clearPlansBtn.textContent = i18n("clearPlans");
feedbackGood.textContent  = i18n("feedbackGood");
feedbackBad.textContent   = i18n("feedbackBad");
notesSubmit.textContent   = i18n("notesSubmit");
collectBtn.textContent    = i18n("collectCoupons");
ollamaBtn.textContent     = i18n("buildPlan");
testBtn.textContent       = i18n("testCoupons");
stopBtn.title             = i18n("stopRun");

// ── Status ────────────────────────────────────────────────────────────────

type Level = "info" | "success" | "error" | "warning";

function setStatus(msg: string, level: Level = "info"): void {
  statusEl.textContent = msg;
  statusEl.className   = level === "info" ? "" : level;
  chrome.storage.session.set({ popup_status: { text: msg, level } });
}

function isSyntheticTestCode(code: string): boolean {
  return /^TEST[A-Z0-9]{6}$/i.test(code);
}

function showStopButton(show: boolean): void {
  stopBtn.classList.toggle("hidden", !show);
}

// ── Helpers ───────────────────────────────────────────────────────────────

function randomCouponCode(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  return "TEST" + Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

async function getCurrentHostname(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.url) return null;
  try { return new URL(tab.url).hostname; } catch { return null; }
}

// ── Ollama model list ─────────────────────────────────────────────────────

const OLLAMA_URL = "http://localhost:11434";
const MODEL_KEY  = "last_model";

async function loadModels(): Promise<void> {
  modelSelect.disabled = true;
  modelStatus.textContent = "";
  try {
    const res = await fetch(`${OLLAMA_URL}/api/tags`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json() as { models: Array<{ name: string }> };
    const models = data.models ?? [];

    modelSelect.innerHTML = "";
    if (models.length === 0) {
      modelSelect.innerHTML = `<option value="" disabled selected>No models found</option>`;
      return;
    }
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = opt.textContent = m.name;
      modelSelect.appendChild(opt);
    }
    modelSelect.disabled = false;

    // Restore last selected model
    const stored = await chrome.storage.local.get(MODEL_KEY);
    const last = stored[MODEL_KEY] as string | undefined;
    if (last && Array.from(modelSelect.options).some(o => o.value === last)) {
      modelSelect.value = last;
    }

    console.log("[Coupon Tester] Models loaded:", models.map(m => m.name));
  } catch (err) {
    console.error("[Coupon Tester] ollama unreachable:", err);
    modelStatus.textContent = i18n("ollamaNotRunning");
    modelSelect.innerHTML = `<option value="" disabled selected>—</option>`;
  }
}

modelSelect.addEventListener("change", () => {
  if (modelSelect.value) chrome.storage.local.set({ [MODEL_KEY]: modelSelect.value });
});

// ── History (per-site) ────────────────────────────────────────────────────

interface HistoryEntry { code: string; result?: CouponResult; reason?: string }

const MAX_HISTORY = 200;

function historyKey(hostname: string): string { return `coupon_history_${hostname}`; }

async function loadHistory(hostname: string): Promise<HistoryEntry[]> {
  const key = historyKey(hostname);
  const d = await chrome.storage.local.get(key);
  return (d[key] as HistoryEntry[]) ?? [];
}

async function saveHistory(hostname: string, entries: HistoryEntry[]): Promise<void> {
  await chrome.storage.local.set({ [historyKey(hostname)]: entries });
}

async function addToHistory(hostname: string, entry: HistoryEntry): Promise<void> {
  const h = await loadHistory(hostname);
  const filtered = h.filter(e => e.code !== entry.code);
  filtered.unshift(entry);
  await saveHistory(hostname, filtered.slice(0, MAX_HISTORY));
  await renderHistory();
}

async function renderHistory(): Promise<void> {
  const hostname = await getCurrentHostname();
  if (!hostname) { historySection.classList.add("hidden"); return; }
  const history = await loadHistory(hostname);
  historyList.innerHTML = "";
  if (history.length === 0) { historySection.classList.add("hidden"); return; }
  historySection.classList.remove("hidden");
  for (const entry of history) {
    const li   = document.createElement("li");
    const code = document.createElement("span");
    code.className   = "code";
    code.textContent = entry.code;

    if (entry.result) {
      const badge = document.createElement("span");
      const badgeClass = entry.result === "success" ? "success" : entry.result === "rejected" ? "rejected" : "error";
      const badgeText  = entry.result === "success" ? "✓" : entry.result === "rejected" ? "✗" : "?";
      badge.className   = `badge ${badgeClass}`;
      badge.textContent = badgeText;
      if ((entry.result === "rejected" || entry.result === "error") && entry.reason) {
        badge.title = entry.reason;
      }
      li.append(code, badge);
    } else {
      li.append(code);
    }

    historyList.appendChild(li);
  }
}

clearBtn.addEventListener("click", async () => {
  const hostname = await getCurrentHostname();
  if (hostname) await saveHistory(hostname, []);
  await renderHistory();
});

collectBtn.addEventListener("click", async () => {
  const hostname = await getCurrentHostname();
  if (!hostname) { setStatus(i18n("statusError"), "error"); return; }

  hideFeedback();
  hideNotes();
  collectBtn.disabled = true;
  showStopButton(true);
  setStatus(i18n("statusCollectingCoupons"), "info");

  try {
    const res = await chrome.runtime.sendMessage({ type: "COLLECT_COUPONS", hostname }) as {
      ok: boolean;
      added?: number;
      totalFound?: number;
      error?: string;
    };

    if (!res?.ok) {
      throw new Error(res?.error ?? "Unknown collection error");
    }

    const added = res.added ?? 0;
    const totalFound = res.totalFound ?? 0;
    setStatus(i18n("statusCollectedCoupons", [String(added), String(totalFound)]), "success");
    await renderHistory();
  } catch (err) {
    console.error("[Coupon Tester] collect coupons failed:", err);
    const detail = err instanceof Error ? err.message : String(err);
    setStatus(`${i18n("statusCollectCouponsError")} (${detail})`, "error");
  } finally {
    collectBtn.disabled = false;
    showStopButton(false);
  }
});

testBtn.addEventListener("click", async () => {
  const model = modelSelect.value;
  if (!model) { setStatus(i18n("ollamaNotRunning"), "error"); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) { setStatus(i18n("statusError"), "error"); return; }

  let hostname: string | null = null;
  try { hostname = new URL(tab.url).hostname; } catch { /* ignore */ }
  if (!hostname) { setStatus(i18n("statusError"), "error"); return; }

  hideFeedback();
  hideNotes();
  ollamaBtn.disabled = true;
  collectBtn.disabled = true;
  testBtn.disabled = true;
  showStopButton(true);
  setStatus(i18n("statusTestingCoupons"), "info");

  const port = chrome.runtime.connect({ name: "ai-session" });

  port.onMessage.addListener((msg: PortMessage) => {
    if (msg.type === "STATUS") {
      setStatus(msg.message, msg.level);
    } else if (msg.type === "BATCH_DONE") {
      setStatus(i18n("statusTestCouponsDone", [String(msg.tested), String(msg.good), String(msg.bad), String(msg.errors)]), msg.errors > 0 ? "warning" : "success");
      renderHistory();
      ollamaBtn.disabled = false;
      collectBtn.disabled = false;
      testBtn.disabled = false;
      showStopButton(false);
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    ollamaBtn.disabled = false;
    collectBtn.disabled = false;
    testBtn.disabled = false;
    showStopButton(false);
  });

  chrome.runtime.sendMessage({ type: "TEST_COUPONS", model, tabId: tab.id, hostname });
});

// ── Feedback row ──────────────────────────────────────────────────────────

function showFeedback(): void  { feedbackRow.classList.remove("hidden"); chrome.storage.session.set({ popup_feedback: true }); }
function hideFeedback(): void  { feedbackRow.classList.add("hidden");    chrome.storage.session.set({ popup_feedback: false }); }
function showNotes(): void     { notesRow.classList.remove("hidden"); notesInput.focus(); }
function hideNotes(): void     { notesRow.classList.add("hidden"); notesInput.value = ""; }

function handleDone(msg: import("./types.js").DoneUpdate, hostname: string): void {
  if (!isSyntheticTestCode(msg.code)) {
    addToHistory(hostname, { code: msg.code, result: msg.result, reason: msg.reason });
  }
  if (msg.code2 && msg.code2 !== msg.code && !isSyntheticTestCode(msg.code2)) {
    addToHistory(hostname, {
      code: msg.code2,
      result: msg.inconsistent && msg.run1Result ? msg.run1Result : msg.result,
      reason: msg.reason2 ?? msg.reason,
    });
  }

  const inconsistencySuffix = msg.inconsistent && msg.run1Result
    ? ` ⚠ ${i18n("statusInconsistent", [msg.run1Result, msg.result])}`
    : "";

  if (msg.result === "success") {
    setStatus(`${i18n("statusSuccess")} (${msg.code})${inconsistencySuffix}`, msg.inconsistent ? "warning" : "success");
    if (!msg.planUsed) showFeedback();
  } else if (msg.result === "rejected") {
    setStatus(`${i18n("statusRejected")}${inconsistencySuffix}`, "warning");
    if (!msg.planUsed) showFeedback();
  } else {
    setStatus(`${i18n("statusError")}${inconsistencySuffix}`, "error");
    showNotes();
  }

  if (msg.inconsistent) showNotes();
}

feedbackBad.addEventListener("click", () => {
  hideFeedback();
  showNotes();
});

notesSubmit.addEventListener("click", async () => {
  const notes = notesInput.value.trim();
  const hostname = await getCurrentHostname();
  if (hostname && notes) {
    await chrome.storage.session.set({ [`correction_notes_${hostname}`]: notes });
  }
  hideNotes();
});

feedbackGood.addEventListener("click", async () => {
  hideFeedback();
  const model = modelSelect.value;
  if (!model) return;
  const hostname = await getCurrentHostname();
  if (!hostname) return;

  setStatus(i18n("statusGeneratingPlan"), "info");

  const port = chrome.runtime.connect({ name: "ai-session" });
  port.onMessage.addListener((msg: PortMessage) => {
    if (msg.type === "STATUS") {
      setStatus(msg.message, msg.level);
    } else if (msg.type === "PLAN_SAVED") {
      setStatus(i18n("statusPlanSaved"), "success");
      renderPlans();
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {});

  chrome.runtime.sendMessage({ type: "GENERATE_PLAN", model, hostname });
});

// ── Plans (per-site) ──────────────────────────────────────────────────────

const PLANS_KEY_PREFIX = "execution_plans_";

function plansKey(hostname: string): string { return `${PLANS_KEY_PREFIX}${hostname}`; }

async function loadPlans(hostname: string): Promise<ExecutionPlan[]> {
  const key = plansKey(hostname);
  const d = await chrome.storage.local.get(key);
  return (d[key] as ExecutionPlan[]) ?? [];
}

async function savePlans(hostname: string, plans: ExecutionPlan[]): Promise<void> {
  await chrome.storage.local.set({ [plansKey(hostname)]: plans });
}

async function renderPlans(): Promise<void> {
  const hostname = await getCurrentHostname();
  if (!hostname) { plansSection.classList.add("hidden"); return; }
  const plans = await loadPlans(hostname);
  plansList.innerHTML = "";
  if (plans.length === 0) { plansSection.classList.add("hidden"); return; }
  plansSection.classList.remove("hidden");

  for (const p of plans) {
    const li = document.createElement("li");
    li.className = "plan-item";

    const header = document.createElement("div");
    header.className = "plan-header";

    const date = document.createElement("span");
    date.className = "plan-date";
    date.textContent = new Date(p.createdAt).toLocaleDateString();

    const deleteBtn = document.createElement("button");
    deleteBtn.className = "btn-icon";
    deleteBtn.textContent = "×";
    deleteBtn.title = i18n("deletePlan");
    deleteBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const current = await loadPlans(hostname);
      await savePlans(hostname, current.filter(x => x.id !== p.id));
      await renderPlans();
    });

    header.append(date, deleteBtn);

    const preview = document.createElement("div");
    preview.className = "plan-preview";
    preview.textContent = p.plan.slice(0, 80) + (p.plan.length > 80 ? "…" : "");

    const full = document.createElement("div");
    full.className = "plan-full hidden";
    full.textContent = p.plan;

    preview.addEventListener("click", () => {
      full.classList.toggle("hidden");
      preview.classList.toggle("hidden");
    });
    full.addEventListener("click", () => {
      full.classList.toggle("hidden");
      preview.classList.toggle("hidden");
    });

    li.append(header, preview, full);
    plansList.appendChild(li);
  }
}

clearPlansBtn.addEventListener("click", async () => {
  const hostname = await getCurrentHostname();
  if (hostname) await savePlans(hostname, []);
  await renderPlans();
});

// ── TEST CUPONS ───────────────────────────────────────────────────────────

ollamaBtn.addEventListener("click", async () => {
  const model = modelSelect.value;
  if (!model) { setStatus(i18n("ollamaNotRunning"), "error"); return; }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) { setStatus(i18n("statusError"), "error"); return; }

  let hostname: string | null = null;
  try { hostname = tab.url ? new URL(tab.url).hostname : null; } catch { /* ignore */ }
  if (!hostname) { setStatus(i18n("statusError"), "error"); return; }

  const code  = randomCouponCode();
  const code2 = randomCouponCode();

  hideFeedback();
  hideNotes();
  ollamaBtn.disabled = true;
  collectBtn.disabled = true;
  testBtn.disabled = true;
  showStopButton(true);
  setStatus(i18n("statusApplying"), "info");

  // Pick up any correction notes left from a previous bad run, then clear them
  const notesKey = `correction_notes_${hostname}`;
  const notesData = await chrome.storage.session.get(notesKey);
  const correctionNotes = (notesData[notesKey] as string | undefined) ?? "";
  if (correctionNotes) await chrome.storage.session.remove(notesKey);

  const port = chrome.runtime.connect({ name: "ai-session" });

  port.onMessage.addListener((msg: PortMessage) => {
    if (msg.type === "STATUS") {
      setStatus(msg.message, msg.level);
    } else if (msg.type === "DONE") {
      handleDone(msg, hostname!);
      ollamaBtn.disabled = false;
      collectBtn.disabled = false;
      testBtn.disabled = false;
      showStopButton(false);
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    ollamaBtn.disabled = false;
    collectBtn.disabled = false;
    testBtn.disabled = false;
    showStopButton(false);
  });

  chrome.runtime.sendMessage({ type: "RUN_AI", model, couponCode: code, couponCode2: code2, tabId: tab.id, hostname, correctionNotes: correctionNotes || undefined });
});

// ── Init ──────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const saved = await chrome.storage.session.get(["popup_status", "popup_feedback", "session_running"]);

  // Restore status
  const s = saved.popup_status as { text: string; level: Level } | undefined;
  if (s) {
    statusEl.textContent = s.text;
    statusEl.className   = s.level === "info" ? "" : s.level;
  } else {
    setStatus(i18n("statusIdle"), "info");
  }

  // Restore feedback visibility
  if (saved.popup_feedback === true) feedbackRow.classList.remove("hidden");

  // Reconnect port if a session is still running
  if (saved.session_running === true) {
    ollamaBtn.disabled = true;
    collectBtn.disabled = true;
    testBtn.disabled = true;
    showStopButton(true);
    const port = chrome.runtime.connect({ name: "ai-session" });
    port.onMessage.addListener((msg: PortMessage) => {
      if (msg.type === "STATUS") {
        setStatus(msg.message, msg.level);
      } else if (msg.type === "DONE") {
        const hostname = (async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
          return tab?.url ? new URL(tab.url).hostname : null;
        })();
        hostname.then(h => { if (h) handleDone(msg, h); });
        ollamaBtn.disabled = false;
        collectBtn.disabled = false;
        testBtn.disabled = false;
        showStopButton(false);
        port.disconnect();
      } else if (msg.type === "BATCH_DONE") {
        setStatus(i18n("statusTestCouponsDone", [String(msg.tested), String(msg.good), String(msg.bad), String(msg.errors)]), msg.errors > 0 ? "warning" : "success");
        renderHistory();
        ollamaBtn.disabled = false;
        collectBtn.disabled = false;
        testBtn.disabled = false;
        showStopButton(false);
        port.disconnect();
      } else if (msg.type === "PLAN_SAVED") {
        setStatus(i18n("statusPlanSaved"), "success");
        renderPlans();
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      ollamaBtn.disabled = false;
      collectBtn.disabled = false;
      testBtn.disabled = false;
      showStopButton(false);
    });
  } else {
    showStopButton(false);
  }

  loadModels();
  renderHistory();
  renderPlans();
}

init();

stopBtn.addEventListener("click", async () => {
  stopBtn.disabled = true;
  setStatus(i18n("statusStopping"), "warning");
  try {
    await chrome.runtime.sendMessage({ type: "STOP_SESSION" });
  } finally {
    stopBtn.disabled = false;
  }
});

