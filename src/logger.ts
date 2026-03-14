/**
 * Overrides console.log/info/warn/error to also forward to the local log
 * server (http://localhost:7777/log). Original browser console behaviour
 * is fully preserved — you still see everything in DevTools.
 *
 * Import this module once at the top of each entry-point script.
 * The `source` tag identifies which script the message came from.
 */

const LOG_URL = "http://localhost:7777/log";

function serialize(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
  if (typeof a === "object" && a !== null) {
    try { return JSON.stringify(a); } catch { return String(a); }
  }
  return String(a);
}

function forward(source: string, level: string, args: unknown[]): void {
  const message = args.map(serialize).join(" ");
  fetch(LOG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ source, level, message }),
  }).catch(() => { /* server not running — ignore */ });
}

export function installConsoleForwarder(source: "popup" | "background" | "content"): void {
  const _log   = console.log.bind(console);
  const _info  = console.info.bind(console);
  const _warn  = console.warn.bind(console);
  const _error = console.error.bind(console);

  console.log = (...args: unknown[]) => { _log(...args);   forward(source, "log",   args); };
  console.info  = (...args: unknown[]) => { _info(...args);  forward(source, "info",  args); };
  console.warn  = (...args: unknown[]) => { _warn(...args);  forward(source, "warn",  args); };
  console.error = (...args: unknown[]) => { _error(...args); forward(source, "error", args); };
}
