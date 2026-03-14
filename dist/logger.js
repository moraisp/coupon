/**
 * Overrides console.log/info/warn/error to also forward to the local log
 * server (http://localhost:7777/log). Original browser console behaviour
 * is fully preserved — you still see everything in DevTools.
 *
 * Import this module once at the top of each entry-point script.
 * The `source` tag identifies which script the message came from.
 */
const LOG_URL = "http://localhost:7777/log";
function serialize(a) {
    if (a instanceof Error)
        return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
    if (typeof a === "object" && a !== null) {
        try {
            return JSON.stringify(a);
        }
        catch {
            return String(a);
        }
    }
    return String(a);
}
function forward(source, level, args) {
    const message = args.map(serialize).join(" ");
    fetch(LOG_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source, level, message }),
    }).catch(() => { });
}
export function installConsoleForwarder(source) {
    const _log = console.log.bind(console);
    const _info = console.info.bind(console);
    const _warn = console.warn.bind(console);
    const _error = console.error.bind(console);
    console.log = (...args) => { _log(...args); forward(source, "log", args); };
    console.info = (...args) => { _info(...args); forward(source, "info", args); };
    console.warn = (...args) => { _warn(...args); forward(source, "warn", args); };
    console.error = (...args) => { _error(...args); forward(source, "error", args); };
}
//# sourceMappingURL=logger.js.map