"use strict";

// Consumer of domain-recon schema v1; no scanner or network dependency.
const { domainToASCII } = require("node:url");
const { isIP } = require("node:net");

function repositoryKey(fullName) {
  if (
    typeof fullName !== "string" ||
    !/^[a-z\d][a-z\d-]*\/[a-z\d_.-]+$/i.test(fullName) ||
    [".", ".."].includes(fullName.split("/")[1])
  )
    throw new Error("Invalid domain repository identity");
  return `github.com/${fullName.toLowerCase()}`;
}

function normalizeHost(value) {
  if (typeof value !== "string" || !value.trim() || /[\s{}$<>?#@\\]/.test(value.trim()))
    return null;
  const raw = value.trim();
  const explicitScheme = /^https?:\/\//i.test(raw);
  if (!explicitScheme && raw.includes("/")) return null;
  try {
    const parsed = new URL(explicitScheme ? raw : `https://${raw}`);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password)
      return null;
    const hostname = domainToASCII(parsed.hostname.replace(/\.$/, "")).toLowerCase();
    const dns = hostname.replace(/^\*\./, "");
    if (
      !hostname ||
      hostname.length > 253 ||
      (!isIP(dns) &&
        !dns.split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)))
    )
      return null;
    const port = parsed.port || (!explicitScheme ? raw.match(/:(\d+)$/)?.[1] : null) || null;
    if (port && Number(port) < 1) return null;
    return {
      hostname,
      port,
      scheme: explicitScheme ? parsed.protocol.slice(0, -1) : null,
      urlPath: explicitScheme && parsed.pathname !== "/" ? parsed.pathname : null,
    };
  } catch {
    return null;
  }
}

function validateBindings(value = { schemaVersion: 1, bindings: [] }) {
  if (value.schemaVersion !== 1 || !Array.isArray(value.bindings))
    throw new Error("Bindings must have schemaVersion 1 and a bindings array");
  for (const binding of value.bindings) {
    repositoryKey(binding.repository);
    if (!binding.applicationId && !binding.specification)
      throw new Error("Each binding needs applicationId or specification");
    if (normalizeHost(binding.hostname)?.hostname !== binding.hostname)
      throw new Error("Binding hostname must be normalized");
    if (binding.scheme && !["http", "https"].includes(binding.scheme))
      throw new Error("Binding scheme must be http or https");
    if (binding.scope && !["internal", "external"].includes(binding.scope))
      throw new Error("Invalid binding scope");
    if (
      binding.basePath !== undefined &&
      (typeof binding.basePath !== "string" ||
        (binding.basePath !== "" && !/^\/(?!\/)[^\s?#{}*\\]*$/.test(binding.basePath)))
    )
      throw new Error("Invalid binding basePath");
  }
  return value;
}

function bindingMatches(binding, observation, context) {
  return (
    repositoryKey(binding.repository) === context.repositoryKey &&
    binding.hostname === observation.hostname &&
    (!binding.applicationId || binding.applicationId === context.applicationId) &&
    (!binding.specification || binding.specification === context.specification) &&
    (!binding.environment || binding.environment === observation.environment) &&
    (!binding.scope || binding.scope === observation.scope)
  );
}

function authoredBasePath(document) {
  if (document.swagger === "2.0")
    return document.basePath && document.basePath !== "/" ? document.basePath : null;
  const servers = document.servers || [];
  return servers.some((s) => {
    try {
      return new URL(s.url, "https://placeholder.invalid").pathname !== "/";
    } catch {
      return true;
    }
  });
}

function enrichOpenApi(
  document,
  repo,
  {
    applicationIds = [],
    applicationId,
    specification,
    bindings = { schemaVersion: 1, bindings: [] },
    environment,
    scope,
    maxAgeDays = 30,
    now = Date.now(),
  } = {},
) {
  const output = structuredClone(document);
  if (
    !(typeof output.openapi === "string" && output.openapi.startsWith("3.")) &&
    output.swagger !== "2.0"
  )
    return { document: output, serversAdded: 0 };
  const appId =
    applicationId ||
    output["x-express-recon"]?.reconciliation?.applicationId ||
    (applicationIds.length === 1 ? applicationIds[0] : null);
  const context = { repositoryKey: repo.repository.key, applicationId: appId, specification };
  const rules = bindings.bindings.filter(
    (b) => repositoryKey(b.repository) === context.repositoryKey,
  );
  const candidates = [];
  const unresolved = new Set();
  for (const observation of repo.domains.flatMap((d) => d.observations)) {
    if (environment && observation.environment !== environment) continue;
    if (scope && observation.scope !== scope) continue;
    if (normalizeHost(observation.hostname)?.hostname !== observation.hostname)
      throw new Error("Invalid catalog hostname");
    const matches = rules.filter((b) => bindingMatches(b, observation, context));
    if (matches.length > 1)
      throw new Error(
        `Overlapping domain bindings for ${context.repositoryKey} / ${observation.hostname}`,
      );
    const binding = matches[0];
    const reason = (() => {
      if (repo.status !== "complete") return "incomplete-domain-scan";
      const age = now - Date.parse(observation.source.observedAt);
      if (!Number.isFinite(age) || age > maxAgeDays * 86400000 || age < -300000)
        return "stale-domain-evidence";
      if (rules.length && !binding) return "not-bound-to-this-specification";
      if (!binding && (applicationIds.length !== 1 || !appId || appId !== applicationIds[0]))
        return "ambiguous-application";
      if (observation.hostname.startsWith("*.")) return "wildcard-needs-concrete-host";
      if (!(binding?.scheme || observation.scheme)) return "unknown-scheme";
      if (!binding && observation.paths.some((p) => p !== "/" && p !== "/*"))
        return "ingress-path-needs-explicit-binding";
      if (binding?.basePath === undefined && authoredBasePath(output))
        return "base-path-needs-explicit-binding";
      return null;
    })();
    if (reason) {
      unresolved.add(reason);
      continue;
    }
    const protocol = binding?.scheme || observation.scheme;
    if (!["https", "http"].includes(protocol)) throw new Error("Invalid catalog scheme");
    const basePath = binding?.basePath ?? observation.urlPath ?? "";
    const port = observation.port ? `:${observation.port}` : "";
    const url = `${protocol}://${observation.hostname}${port}${basePath === "/" ? "" : basePath}`;
    // Validate before adding anything executable to an OpenAPI server selector.
    const parsed = new URL(url);
    if (
      parsed.hostname !== observation.hostname ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error("Invalid domain server URL");
    candidates.push({
      url,
      description: [
        observation.environment || "environment unknown",
        observation.scope,
        binding ? "explicit binding" : "single-app repository",
      ].join(" · "),
      "x-domain-recon": {
        scope: observation.scope,
        environment: observation.environment,
        association: binding ? "explicit-binding" : "single-application-inferred",
        source: observation.source,
      },
    });
  }
  const unique = [...new Map(candidates.map((s) => [s.url, s])).values()].sort((a, b) =>
    a.url.localeCompare(b.url),
  );
  output["x-domain-recon"] = {
    schemaVersion: 1,
    repositoryKey: context.repositoryKey,
    applicationId: appId,
    uniqueHostCount: repo.domains.length,
    sourceCommit: repo.sourceCommit,
    lastSuccessAt: repo.lastSuccessAt,
    status: repo.status,
    hostnames: repo.domains.map((d) => d.hostname),
    candidates: unique,
    unresolvedReasons: [...unresolved].sort(),
    note: "Deployment configuration evidence; not runtime or public reachability verification.",
  };
  let serversAdded = 0;
  if (output.swagger === "2.0") {
    // Swagger 2 has one host, not an OAS3 servers array. Never arbitrarily pick
    // among deployments or overwrite an authored host/scheme/base path.
    if (!output.host && unique.length === 1) {
      const server = new URL(unique[0].url);
      const scheme = server.protocol.slice(0, -1);
      const basePath = server.pathname === "/" ? "" : server.pathname;
      const existingBase = output.basePath === "/" ? "" : output.basePath || "";
      if (
        (!output.schemes || output.schemes.includes(scheme)) &&
        (!Object.hasOwn(output, "basePath") || existingBase === basePath)
      ) {
        output.host = server.host;
        output.schemes ??= [scheme];
        if (basePath) output.basePath ??= basePath;
        serversAdded = 1;
      }
    }
  } else {
    const existing = new Set((output.servers || []).map((s) => s.url));
    const additions = unique.filter((s) => !existing.has(s.url));
    if (additions.length) output.servers = [...(output.servers || []), ...additions];
    serversAdded = additions.length;
    // Authored path/operation servers keep their standard override semantics.
  }
  return { document: output, serversAdded };
}

module.exports = { enrichOpenApi, normalizeHost, repositoryKey, validateBindings };
