"use strict";

const PROGRESS_MODES = new Set(["auto", "plain", "json", "none"]);

function resolveProgressMode(value = "auto", isTTY = process.stderr.isTTY === true) {
  if (!PROGRESS_MODES.has(value)) {
    throw new Error("--progress must be auto, plain, json, or none");
  }
  return value === "auto" ? (isTTY ? "tty" : "plain") : value;
}

function cleanLine(value) {
  let output = "";
  let replacing = false;
  for (const character of String(value ?? "")) {
    const code = character.charCodeAt(0);
    if (code <= 31 || code === 127) {
      if (!replacing) output += " ";
      replacing = true;
    } else {
      output += character;
      replacing = false;
    }
  }
  return output.trim();
}

function duration(value) {
  if (!Number.isFinite(value) || value < 0) return null;
  if (value < 1_000) return `${Math.round(value)}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

function progressPrefix(event) {
  if (Number.isSafeInteger(event.processed) && Number.isSafeInteger(event.total)) {
    return `[${event.processed}/${event.total}]`;
  }
  return "[org]";
}

function repositoryLabel(event) {
  return cleanLine(event.repository || event.fullName || "repository");
}

function formatPlainProgress(event) {
  const prefix = `express-recon ${progressPrefix(event)}`;
  const repository = repositoryLabel(event);
  const elapsed = duration(event.durationMs ?? event.elapsedMs);
  switch (event.event) {
    case "enumeration-started":
      return `${prefix} ENUMERATE ${cleanLine(event.organization)}`;
    case "enumeration-completed":
      return (
        `${prefix} READY ${event.discovered ?? 0} discovered · ${event.selected ?? 0} selected` +
        ` · ${event.skipped ?? 0} skipped` +
        ` · ${event.resumed ?? 0} resumed` +
        `${event.reused ? ` · ${event.reused} unchanged` : ""}` +
        ` · ${event.pending ?? 0} pending` +
        ` · concurrency ${event.concurrency ?? 1}`
      );
    case "enumeration-page":
      return (
        `${prefix} PAGE ${event.page ?? event.pagesFetched ?? "?"}` +
        ` · ${event.repositoriesDiscovered ?? 0} visible` +
        `${Number.isSafeInteger(event.rateLimit?.remaining) ? ` · API remaining ${event.rateLimit.remaining}` : ""}`
      );
    case "enumeration-failed":
      return `${prefix} FAILED enumeration · ${cleanLine(event.error)}`;
    case "scan-failed":
      return `${prefix} FAILED ${cleanLine(event.organization)} scan · ${cleanLine(event.error)}`;
    case "repository-skipped":
      return null;
    case "repository-resumed":
      return (
        `${prefix} RESUME ${repository} · ${cleanLine(event.status)}` +
        `${event.routeGraphComplete === false ? " · route graph incomplete" : ""}`
      );
    case "repository-reused":
      return (
        `${prefix} REUSE ${repository} · unchanged upstream` +
        `${event.routeGraphComplete === false ? " · route graph incomplete" : ""}`
      );
    case "repository-retry":
      return (
        `${prefix} RETRY ${repository} · attempt ${event.nextAttempt ?? "?"}` +
        ` · ${cleanLine(event.error)}`
      );
    case "repository-reuse-invalidated":
      return `${prefix} RESCAN ${repository} · saved artifact unavailable · ${cleanLine(event.error)}`;
    case "repository-started":
      return `${prefix} START ${repository} · active ${event.active ?? 1}/${event.concurrency ?? 1}`;
    case "repository-phase":
      return `${prefix} PHASE ${repository} · ${cleanLine(event.phase)}`;
    case "repository-completed": {
      const details = [cleanLine(event.status)];
      if (Number.isSafeInteger(event.routes)) details.push(`${event.routes} routes`);
      if (Number.isSafeInteger(event.applications)) details.push(`${event.applications} apps`);
      if (event.routeGraphComplete === false) details.push("route graph incomplete");
      if (elapsed) details.push(elapsed);
      return `${prefix} COMPLETE ${repository} · ${details.join(" · ")}`;
    }
    case "repository-failed":
      return `${prefix} FAILED ${repository} · ${cleanLine(event.error)}${elapsed ? ` · ${elapsed}` : ""}`;
    case "checkpoint-written":
      return `${prefix} CHECKPOINT ${repository} · ${event.completedRepositories ?? 0} durable`;
    case "resume-warning":
      return `${prefix} WARN resume · ${cleanLine(event.message)}`;
    case "gate-triggered":
      return `${prefix} GATE ${cleanLine(event.gate)} · ${cleanLine(event.message)}`;
    case "scan-finished":
      return (
        `${prefix} FINISHED ${cleanLine(event.organization)}` +
        ` · ${event.completed ?? event.processed ?? 0}/${event.total ?? 0} processed` +
        ` · ${
          event.supportedRepositories === undefined
            ? `${event.expressRepositories ?? 0} express`
            : `${event.supportedRepositories} supported`
        }` +
        ` · ${event.failedRepositories ?? 0} failed` +
        `${event.incompleteRouteGraphs ? ` · ${event.incompleteRouteGraphs} unresolved graphs` : ""}` +
        ` · ${event.complete === true ? "complete" : "incomplete"}` +
        `${elapsed ? ` · ${elapsed}` : ""}`
      );
    default:
      return `${prefix} ${cleanLine(event.event || "PROGRESS").toUpperCase()}${repository ? ` ${repository}` : ""}`;
  }
}

function createOrganizationProgressReporter(options = {}) {
  const stream = options.stream || process.stderr;
  const requestedMode = options.mode || "auto";
  const mode = resolveProgressMode(
    requestedMode,
    options.isTTY === undefined ? stream.isTTY === true : options.isTTY === true,
  );
  const now = options.now || Date.now;
  const startedAt = now();
  let disabled = mode === "none";
  let lastWidth = 0;
  const state = {
    active: new Map(),
    complete: false,
    failed: 0,
    processed: 0,
    total: 0,
  };

  function write(value) {
    if (disabled) return false;
    try {
      stream.write(value);
      return true;
    } catch {
      disabled = true;
      return false;
    }
  }

  function clearStatus() {
    if (mode !== "tty" || lastWidth === 0) return;
    write(`\r${" ".repeat(lastWidth)}\r`);
    lastWidth = 0;
  }

  function statusLine() {
    if (!state.total || state.complete) return null;
    const active = [...state.active.entries()]
      .map(([name, phase]) => `${name}${phase ? `:${phase}` : ""}`)
      .join(", ");
    return cleanLine(
      `express-recon ${state.processed}/${state.total} processed · ${state.active.size} active` +
        ` · ${state.failed} failed${active ? ` · ${active}` : ""}`,
    );
  }

  function renderStatus() {
    if (mode !== "tty") return;
    clearStatus();
    const value = statusLine();
    if (!value) return;
    lastWidth = value.length;
    write(`\r${value}`);
  }

  function updateState(event) {
    if (Number.isSafeInteger(event.total)) state.total = event.total;
    if (Number.isSafeInteger(event.processed)) state.processed = event.processed;
    if (Number.isSafeInteger(event.failed)) state.failed = event.failed;
    if (event.event === "repository-started") {
      state.active.set(repositoryLabel(event), null);
    } else if (event.event === "repository-phase") {
      state.active.set(repositoryLabel(event), cleanLine(event.phase));
    } else if (
      event.event === "repository-completed" ||
      event.event === "repository-failed" ||
      event.event === "repository-resumed" ||
      event.event === "repository-reused"
    ) {
      state.active.delete(repositoryLabel(event));
    } else if (event.event === "scan-finished") {
      state.active.clear();
      state.complete = true;
    }
  }

  function emit(rawEvent) {
    if (disabled) return null;
    const current = now();
    const event = {
      schemaVersion: "1.0",
      kind: "organization-scan-progress",
      timestamp: new Date(current).toISOString(),
      elapsedMs: Math.max(0, current - startedAt),
      ...rawEvent,
    };
    updateState(event);
    if (mode === "json") {
      return write(`${JSON.stringify(event)}\n`) ? event : null;
    }
    if (mode === "plain") {
      const line = formatPlainProgress(event);
      return !line || write(`${line}\n`) ? event : null;
    }
    if (event.event === "repository-skipped") return event;
    clearStatus();
    if (event.event !== "repository-phase") {
      const line = formatPlainProgress(event);
      if (line) write(`${line}\n`);
    }
    renderStatus();
    return event;
  }

  function close() {
    clearStatus();
  }

  return {
    close,
    emit,
    mode,
    requestedMode,
  };
}

module.exports = {
  PROGRESS_MODES,
  createOrganizationProgressReporter,
  formatPlainProgress,
  resolveProgressMode,
};
