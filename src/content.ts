// Inline types — no imports allowed in content scripts
interface InputInfo  { selector: string; frameIdx: number; inputType: string; placeholder: string; name: string; id: string; label: string; visible: boolean }
interface ButtonInfo { selector: string; frameIdx: number; text: string; id: string; buttonType: string; disabled: boolean }
interface LinkInfo   { selector: string; frameIdx: number; text: string }
interface PageInfo   { title: string; url: string; inputs: InputInfo[]; buttons: ButtonInfo[]; links: LinkInfo[] }

(function patchConsole() {
  const LOG_URL = "http://localhost:7777/log";
  const src = "content";
  function fwd(level: string, args: unknown[]) {
    const message = args.map((a) => a instanceof Error ? `${a.name}: ${a.message}` : typeof a === "object" ? JSON.stringify(a) : String(a)).join(" ");
    fetch(LOG_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source: src, level, message }) }).catch(() => {});
  }
  const _log = console.log.bind(console), _warn = console.warn.bind(console), _error = console.error.bind(console);
  console.log   = (...a: unknown[]) => { _log(...a);   fwd("log",   a); };
  console.warn  = (...a: unknown[]) => { _warn(...a);  fwd("warn",  a); };
  console.error = (...a: unknown[]) => { _error(...a); fwd("error", a); };
})();

// ── Frame helpers ─────────────────────────────────────────────────────────

/** Returns the main document plus all accessible same-origin iframes. */
function getAccessibleDocs(): Array<{ doc: Document; frameIdx: number }> {
  const docs: Array<{ doc: Document; frameIdx: number }> = [{ doc: document, frameIdx: 0 }];
  const frames = Array.from(document.querySelectorAll<HTMLIFrameElement>("iframe"));
  frames.forEach((fr, i) => {
    try {
      const d = fr.contentDocument;
      if (d) docs.push({ doc: d, frameIdx: i + 1 });
    } catch { /* cross-origin — skip */ }
  });
  return docs;
}

function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent !== null) return true;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function findLabel(doc: Document, el: HTMLElement): string {
  if (el.id) {
    const lbl = doc.querySelector<HTMLLabelElement>(`label[for="${el.id}"]`);
    if (lbl) return lbl.textContent?.trim() ?? "";
  }
  const parentLabel = el.closest("label");
  if (parentLabel) return parentLabel.textContent?.trim() ?? "";
  const prev = el.previousElementSibling;
  if (prev?.tagName === "LABEL") return prev.textContent?.trim() ?? "";
  return "";
}

function nativeSetter(el: HTMLInputElement, value: string): void {
  const proto = el.ownerDocument.defaultView?.HTMLInputElement?.prototype ?? HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

/** Encode a selector that works across frames: "frameIdx:cssSelector" */
function encodeSelector(frameIdx: number, selector: string): string {
  return `${frameIdx}:${selector}`;
}

/** Resolve an encoded selector back to an element */
function resolveSelector(encoded: string): { el: HTMLElement; doc: Document } | null {
  const colon = encoded.indexOf(":");
  const frameIdx = colon > -1 ? parseInt(encoded.slice(0, colon), 10) : 0;
  const selector = colon > -1 ? encoded.slice(colon + 1) : encoded;

  const docs = getAccessibleDocs();
  const entry = docs.find(d => d.frameIdx === frameIdx);
  if (!entry) return null;
  const el = entry.doc.querySelector<HTMLElement>(selector);
  if (!el) return null;
  return { el, doc: entry.doc };
}

// ── Tool: get_page_info ───────────────────────────────────────────────────

function getPageInfo(): PageInfo {
  const inputs: InputInfo[]   = [];
  const buttons: ButtonInfo[] = [];
  const links: LinkInfo[]     = [];

  const COUPON_KEYWORDS = ["cupom", "coupon", "cupão", "desconto", "discount", "voucher", "código de", "codigo de", "inserir"];

  let inputCounter = 0, buttonCounter = 0, linkCounter = 0;

  for (const { doc, frameIdx } of getAccessibleDocs()) {
    // Inputs
    const inputEls = Array.from(
      doc.querySelectorAll<HTMLInputElement>(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="reset"]), textarea'
      )
    );
    inputEls.forEach((el) => {
      const idx = `i${inputCounter++}`;
      el.setAttribute("data-ai-idx", idx);
      inputs.push({
        selector:    encodeSelector(frameIdx, `[data-ai-idx="${idx}"]`),
        frameIdx,
        inputType:   el.type || el.tagName.toLowerCase(),
        placeholder: el.placeholder ?? "",
        name:        el.name ?? "",
        id:          el.id ?? "",
        label:       findLabel(doc, el),
        visible:     isVisible(el),
      });
    });

    // Buttons
    const buttonEls = Array.from(
      doc.querySelectorAll<HTMLElement>('button, input[type="submit"], input[type="button"], input[type="reset"]')
    );
    buttonEls.forEach((el) => {
      const idx = `b${buttonCounter++}`;
      el.setAttribute("data-ai-idx", idx);
      buttons.push({
        selector:   encodeSelector(frameIdx, `[data-ai-idx="${idx}"]`),
        frameIdx,
        text:       (el.textContent ?? "").trim().slice(0, 80),
        id:         el.id ?? "",
        buttonType: (el as HTMLButtonElement).type ?? "",
        disabled:   (el as HTMLButtonElement).disabled ?? false,
      });
    });

    // Coupon-related links/clickable elements
    const linkEls = Array.from(doc.querySelectorAll<HTMLElement>("a, button, [role='button'], span, div"))
      .filter((el) => {
        const t = (el.textContent ?? "").trim().toLowerCase();
        if (t.length > 120) return false;
        return COUPON_KEYWORDS.some((kw) => t.includes(kw));
      })
      .filter((el, _i, arr) => !arr.some((other) => other !== el && el.contains(other)));

    linkEls.forEach((el) => {
      const idx = `l${linkCounter++}`;
      el.setAttribute("data-ai-idx", idx);
      links.push({
        selector: encodeSelector(frameIdx, `[data-ai-idx="${idx}"]`),
        frameIdx,
        text:     (el.textContent ?? "").trim().slice(0, 80),
      });
    });
  }

  console.log("[Coupon Tester] get_page_info →", inputs.length, "inputs,", buttons.length, "buttons,", links.length, "coupon links, across", getAccessibleDocs().length, "frames");
  return { title: document.title, url: location.href, inputs, buttons, links };
}

// ── Tool: fill_input ──────────────────────────────────────────────────────

function fillInput(encodedSelector: string, value: string): void {
  const resolved = resolveSelector(encodedSelector);
  if (!resolved) throw new Error(`fill_input: no element found for "${encodedSelector}"`);
  const { el } = resolved;
  const input = el as HTMLInputElement;

  input.focus();
  nativeSetter(input, value);
  // Fire all common framework events
  input.dispatchEvent(new Event("input",  { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: value.slice(-1) }));
  input.dispatchEvent(new KeyboardEvent("keyup",   { bubbles: true, key: value.slice(-1) }));
  input.dispatchEvent(new Event("blur",   { bubbles: true }));

  console.log(`[Coupon Tester] fill_input "${encodedSelector}" = "${value}"`);
}

// ── Tool: click_element ───────────────────────────────────────────────────

async function clickElement(encodedSelector: string): Promise<void> {
  const resolved = resolveSelector(encodedSelector);
  if (!resolved) throw new Error(`click_element: no element found for "${encodedSelector}"`);
  const { el } = resolved;

  el.scrollIntoView({ block: "center" });
  el.focus();
  el.click();
  console.log(`[Coupon Tester] click_element "${encodedSelector}"`);
  await new Promise((r) => setTimeout(r, 2000));
}

// ── Tool: query_dom ───────────────────────────────────────────────────────

function queryDom(encodedSelector: string): object {
  const allResults: object[] = [];

  // Support both plain CSS selectors and encoded "frameIdx:selector" format
  const colon = encodedSelector.indexOf(":");
  const hasPrefix = colon > -1 && !isNaN(parseInt(encodedSelector.slice(0, colon), 10));
  const targetFrame = hasPrefix ? parseInt(encodedSelector.slice(0, colon), 10) : null;
  const selector    = hasPrefix ? encodedSelector.slice(colon + 1) : encodedSelector;

  for (const { doc, frameIdx } of getAccessibleDocs()) {
    if (targetFrame !== null && frameIdx !== targetFrame) continue;
    try {
      const els = Array.from(doc.querySelectorAll<HTMLElement>(selector));
      els.slice(0, 5).forEach((el, i) => {
        allResults.push({
          frameIdx,
          index: i,
          tagName: el.tagName,
          id: el.id,
          className: el.className,
          outerHTML: el.outerHTML.slice(0, 2000),
        });
      });
    } catch (err) {
      allResults.push({ frameIdx, error: `Invalid selector: ${String(err)}` });
    }
  }

  console.log(`[Coupon Tester] query_dom "${encodedSelector}" → ${allResults.length} results across frames`);
  return { found: allResults.length, results: allResults };
}

// ── Tool: get_page_text ───────────────────────────────────────────────────

function getPageText(): string {
  const texts: string[] = [];
  for (const { doc, frameIdx } of getAccessibleDocs()) {
    const t = (doc.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 1500);

    const toastSelectors = [
      "[role='alert']",
      "[aria-live]",
      "[class*='toast']",
      "[class*='snackbar']",
      "[data-testid*='toast']",
      "[data-testid*='alert']",
    ].join(",");

    const toastText = Array.from(doc.querySelectorAll<HTMLElement>(toastSelectors))
      .map((el) => (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(" | ");

    const merged = [t, toastText ? `TOAST: ${toastText}` : ""].filter(Boolean).join(" || ").slice(0, 1800);
    if (merged) texts.push(frameIdx === 0 ? merged : `[frame ${frameIdx}] ${merged}`);
  }
  return texts.join("\n---\n");
}

// ── Tool: scrape_pelando_coupons ────────────────────────────────────────

function scrapePelandoCoupons(): { codes: string[]; title: string; url: string } {
  const codes = new Set<string>();

  const maskedEls = Array.from(document.querySelectorAll<HTMLElement>("[data-masked]"));
  maskedEls.forEach((el) => {
    const raw = (el.getAttribute("data-masked") ?? "").trim().toUpperCase();
    if (raw.length >= 4 && raw.length <= 40 && /^[A-Z0-9-]+$/.test(raw)) {
      codes.add(raw);
    }
  });

  const text = (document.body?.innerText ?? "").replace(/\s+/g, " ");
  const visibleCodeRegex = /(?:pegar\s+cupom|cupom(?:\s+de\s+desconto)?)[\s:]+([a-z0-9-]{4,40})/gi;
  let match: RegExpExecArray | null;
  while ((match = visibleCodeRegex.exec(text)) !== null) {
    const code = match[1].trim().toUpperCase();
    if (/^[A-Z0-9-]+$/.test(code)) {
      codes.add(code);
    }
  }

  return { codes: Array.from(codes), title: document.title, url: location.href };
}

function scrapePelandoStoreLinks(): { links: string[]; title: string; url: string } {
  const links = new Set<string>();
  const anchors = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/cupons-de-descontos/"]'));

  anchors.forEach((a) => {
    const href = (a.getAttribute("href") ?? "").trim();
    if (!href) return;
    try {
      const abs = new URL(href, location.origin);
      if (!abs.pathname.startsWith("/cupons-de-descontos/")) return;
      const slug = abs.pathname.replace(/^\/cupons-de-descontos\/?/, "").replace(/\/$/, "");
      if (!slug) return;
      links.add(abs.toString());
    } catch {
      // Ignore invalid hrefs.
    }
  });

  return { links: Array.from(links), title: document.title, url: location.href };
}

// ── Message listener ──────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message.type) {

    case "QUERY_DOM":
      sendResponse(queryDom(message.selector as string));
      return false;

    case "GET_COUPON_INPUTS":
    case "GET_PAGE_INFO":
      sendResponse(getPageInfo());
      return false;

    case "FILL_INPUT":
      try {
        fillInput(message.selector as string, message.value as string);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
      return false;

    case "CLICK_ELEMENT":
      clickElement(message.selector as string)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "GET_PAGE_TEXT":
      sendResponse(getPageText());
      return false;

    case "SCRAPE_PELANDO_COUPONS":
      sendResponse(scrapePelandoCoupons());
      return false;

    case "SCRAPE_PELANDO_STORE_LINKS":
      sendResponse(scrapePelandoStoreLinks());
      return false;
  }
});
