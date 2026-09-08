"use strict";

// Interchange validation and projection only. Never used as scanner/audit input.
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const Ajv = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const bundleSchema = require("../schemas/render/v1/bundle.schema.json");
const repositorySchema = require("../schemas/render/v1/repository.schema.json");
const routesSchema = require("../schemas/render/v1/routes.schema.json");
const { loadSpec, describeRenderableSpecification } = require("./docs");
const { isFrameworkStatus } = require("./frameworks");

const LIMITS = Object.freeze({ fileBytes: 32 * 1024 * 1024, totalBytes: 256 * 1024 * 1024 });
let validators;
function validate(value, kind) {
  validateComplexity(value);
  if (!validators) {
    const ajv = new Ajv({ strict: false, allErrors: false });
    addFormats(ajv);
    ajv.addSchema(repositorySchema);
    validators = { bundle: ajv.compile(bundleSchema), routes: ajv.compile(routesSchema) };
  }
  if (!validators[kind](value)) {
    const error = validators[kind].errors[0];
    throw new Error(`Invalid render ${kind}: ${error.instancePath || "/"} ${error.message}`);
  }
}

function unique(items, key, label) {
  const seen = new Set();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) throw new Error(`Duplicate ${label}: ${id}`);
    seen.add(id);
  }
}

/** Read and validate a render-bundle.json and its contained evidence, offline. */
function loadRenderBundle(file, options = {}) {
  const root = fs.realpathSync(path.dirname(file));
  const budget = options.budget || { bytes: 0, references: 0 };
  const files = [];
  const read = (reference, spec = false) => {
    if (++budget.references > 10000) throw new Error("Render bundle artifact count limit exceeded");
    const candidate = path.resolve(root, reference.path);
    const real = fs.realpathSync(candidate);
    const relative = path.relative(root, real);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Artifact escapes bundle folder");
    }
    if (spec && ![".json", ".yaml", ".yml"].includes(path.extname(real).toLowerCase()))
      throw new Error("Bundle specifications must be JSON or YAML files");
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > LIMITS.fileBytes)
      throw new Error("Artifact exceeds regular-file/32 MiB limit");
    budget.bytes += stat.size;
    if (budget.bytes > LIMITS.totalBytes) throw new Error("Bundle exceeds 256 MiB read budget");
    const bytes = fs.readFileSync(real);
    if (reference.sha256 && createHash("sha256").update(bytes).digest("hex") !== reference.sha256) {
      throw new Error("Artifact SHA-256 mismatch");
    }
    const value = spec
      ? loadSpec(real, { root, allowSwagger2: true, maxFileBytes: LIMITS.fileBytes })
      : JSON.parse(bytes.toString("utf8"));
    if (spec) describeRenderableSpecification(value);
    // Specifications are bounded and validated by the existing OpenAPI reader.
    if (!spec) validateComplexity(value);
    files.push({ label: reference.label, value });
    return value;
  };
  const manifest = read({ path: path.basename(file), label: "render-bundle.json" });
  validate(manifest, "bundle");
  if (
    options.organization &&
    organizationKey(manifest.organization) !== organizationKey(options.organization)
  ) {
    throw new Error("Bundle organization host/owner does not match inventory");
  }
  const identity = (name) =>
    manifest.organization.host === "github.com" ? name.toLowerCase() : name;
  unique(manifest.repositories, (repo) => identity(repo.name), "repository");
  unique(manifest.statistics || [], (item) => item.id, "bundle statistic");
  const warnings = [];
  const repositories = manifest.repositories.map((repo) => {
    unique(repo.statistics || [], (item) => item.id, "repository statistic");
    const fullName = `${manifest.organization.owner}/${repo.name}`;
    const reasons = [...repo.coverage.reasons];
    const repoFiles = [];
    let complete = repo.coverage.complete;
    const safeRead = (reference, spec = false) => {
      try {
        const result = read(reference, spec);
        repoFiles.push(files.at(-1));
        return result;
      } catch (error) {
        // Exhausted shared budgets abort this bundle, not an unbounded warning per remaining reference.
        if (budget.references > 10000 || budget.bytes > LIMITS.totalBytes) throw error;
        complete = false;
        const message = `${fullName}: ${reference.path}: ${String(error.message).split(root).join(".")}`;
        warnings.push(message);
        reasons.push(message);
        return undefined;
      }
    };
    let routes = [];
    let hasRoutes = false;
    if (repo.routes) {
      const routeReport = safeRead(repo.routes);
      if (routeReport !== undefined) {
        // A well-formed JSON file with the wrong contract invalidates this bundle.
        validate(routeReport, "routes");
        unique(routeReport.routes, (route) => route.id, "route id");
        for (const route of routeReport.routes) {
          if (!repo.frameworks.includes(route.framework))
            throw new Error(`Route ${route.id} uses an undeclared framework`);
          if (route.path === null || route.pathConfidence !== "full") {
            complete = false;
            if (!reasons.includes("Route paths include unresolved or partial observations"))
              reasons.push("Route paths include unresolved or partial observations");
          }
        }
        routes = routeReport.routes.map((route) => ({
          ...route,
          path: route.path ?? "<unresolved>",
          applicationId: route.applicationId || "unassigned",
          middlewares: (route.middlewares || []).map((name) => ({
            name,
            kind: "identifier",
            raw: name,
          })),
          ...(route.auth ? { authStatus: route.auth.status } : {}),
        }));
        hasRoutes = true;
      }
    }
    const specifications = [];
    for (const ref of repo.specifications || []) {
      const document = safeRead(ref, true);
      if (document)
        specifications.push({
          path: ref.path,
          title: ref.label,
          document,
          ...describeRenderableSpecification(document),
        });
    }
    for (const ref of repo.evidence || []) safeRead(ref);
    const imported = {
      producer: manifest.producer,
      bundleId: manifest.id,
      generatedAt: manifest.generatedAt,
      outcome: repo.outcome,
      complete,
      commit: repo.commit,
      reasons,
      statistics: repo.statistics || [],
      files: repoFiles,
      auth: routes
        .filter((route) => route.auth)
        .map((route) => ({ route: route.id, ...route.auth })),
    };
    const applicationCounts = new Map();
    for (const route of routes)
      applicationCounts.set(
        route.applicationId,
        (applicationCounts.get(route.applicationId) || 0) + 1,
      );
    const applications = [...applicationCounts].map(([id, routeCount]) => ({
      id,
      name: id,
      routeCount,
    }));
    return {
      repository: { name: repo.name, fullName },
      producer: manifest.producer.name,
      status: repo.outcome === "scanned" ? "supported" : repo.outcome,
      scanned: hasRoutes,
      coverageComplete: complete,
      routeGraphComplete: complete,
      frameworks: {
        names: repo.frameworks,
        applicationCount: applications.length,
        routeCount: routes.length,
        documentation: { reconciliationStatus: specifications.length ? "cataloged" : "not-found" },
      },
      scan: {
        kind: "repository-scan",
        repository: { source: fullName, commit: repo.commit },
        inventory: {
          tool: manifest.producer.name,
          command: "inventory",
          mode: "imported",
          routes,
          applications,
          scanCoverage: { complete },
          diagnostics: reasons,
        },
        documentation: {
          status: specifications.length ? "cataloged" : "not-found",
          specifications,
          summary: { available: specifications.length },
        },
        imported,
      },
    };
  });
  const result = {
    manifest,
    warnings,
    report: {
      kind: "github-organization-inventory",
      organization: { login: manifest.organization.owner, host: manifest.organization.host },
      repositories,
      coverage: {
        complete:
          manifest.coverage.complete === true &&
          repositories.every((repo) => repo.coverageComplete === true),
        incompleteRepositories: repositories
          .filter((repo) => repo.coverageComplete !== true)
          .map((repo) => repo.repository.fullName),
      },
      summary: {},
      imports: [
        {
          producer: manifest.producer,
          bundleId: manifest.id,
          generatedAt: manifest.generatedAt,
          complete:
            manifest.coverage.complete === true &&
            repositories.every((repo) => repo.coverageComplete === true),
          reasons: [
            ...manifest.coverage.reasons,
            ...(repositories.some((repo) => repo.coverageComplete !== true)
              ? ["One or more repository observations have incomplete or unknown coverage"]
              : []),
          ],
          statistics: manifest.statistics || [],
          files: [files[0]],
        },
      ],
    },
  };
  summarize(result.report);
  return result;
}

function organizationKey(organization) {
  const host = organization.host || "github.com";
  const owner = organization.owner || organization.login;
  return `${host}/${host === "github.com" ? owner.toLowerCase() : owner}`;
}

const supported = (entry) =>
  isFrameworkStatus(entry.status) || ["gin", "supported"].includes(entry.status);
function summarize(report) {
  const entries = report.repositories;
  const hasFramework = (entry, name) =>
    entry.status === name ||
    entry.frameworks?.names?.includes(name) ||
    entry.frameworks?.items?.some((item) => item.name === name);
  const sum = (field) =>
    entries.reduce(
      (total, entry) => total + ((entry.frameworks || entry.express)?.[field] || 0),
      0,
    );
  report.summary = {
    ...report.summary,
    repositoriesDiscovered: Math.max(report.summary?.repositoriesDiscovered || 0, entries.length),
    repositoriesScanned: entries.filter((entry) => entry.scanned).length,
    supportedRepositories: entries.filter(supported).length,
    expressRepositories: entries.filter((entry) => hasFramework(entry, "express")).length,
    fastifyRepositories: entries.filter((entry) => hasFramework(entry, "fastify")).length,
    nestjsRepositories: entries.filter((entry) => hasFramework(entry, "nestjs")).length,
    applicationRepositories: entries.filter(
      (entry) => supported(entry) && (entry.frameworks || entry.express)?.routeCount > 0,
    ).length,
    applications: sum("applicationCount"),
    routes: sum("routeCount"),
    failedRepositories: entries.filter((entry) => entry.status === "failed").length,
    inconclusiveRepositories: entries.filter((entry) => entry.status === "inconclusive").length,
    incompleteRouteGraphs: entries.filter(
      (entry) => supported(entry) && entry.routeGraphComplete !== true,
    ).length,
  };
  delete report.summary.dependencyOnlyRepositories;
}

function mergeBundle(report, incoming) {
  // Publish a projection only after the entire merge succeeds. Native evidence
  // may be an older/partial envelope; a bad optional import must not mutate it.
  report = {
    ...report,
    repositories: report.repositories.map((entry) => ({
      ...entry,
      ...(entry.importedScans ? { importedScans: [...entry.importedScans] } : {}),
    })),
    imports: [...(report.imports || [])],
  };
  report.imports.push(...incoming.imports);
  const key = (name) =>
    (report.organization.host || "github.com") === "github.com" ? name.toLowerCase() : name;
  const entries = new Map(
    report.repositories.map((entry) => [key(entry.repository.fullName), entry]),
  );
  for (const entry of incoming.repositories) {
    const existing = entries.get(key(entry.repository.fullName));
    if (!existing) {
      report.repositories.push(entry);
      continue;
    }
    const priorCommit = existing.scan?.repository?.commit || existing.repository.commit;
    entry.scan.imported.reasons.push(
      `Existing inventory status: ${existing.status}; coverage: ${existing.coverageComplete === true ? "complete" : "incomplete or unknown"}`,
    );
    if (
      !priorCommit ||
      !entry.scan.repository.commit ||
      priorCommit !== entry.scan.repository.commit
    ) {
      entry.scan.imported.reasons.push(
        "Combined inventory contains different or unknown commits; producer observations are not a single snapshot",
      );
      entry.scan.imported.complete = false;
      entry.coverageComplete = false;
    }
    (existing.importedScans ||= []).push(entry.scan);
    const evidence = existing.frameworks || existing.express || {};
    existing.frameworks = {
      ...evidence,
      names: [
        ...new Set([
          ...(evidence.names || []),
          ...(evidence.items || []).map((item) => item.name),
          ...(isFrameworkStatus(existing.status) && existing.status !== "multi-framework"
            ? [existing.status]
            : []),
          ...entry.frameworks.names,
        ]),
      ],
      applicationCount: (evidence.applicationCount || 0) + entry.frameworks.applicationCount,
      routeCount: (evidence.routeCount || 0) + entry.frameworks.routeCount,
    };
    if (!supported(existing) && supported(entry)) existing.status = "supported";
    existing.scanned = existing.scanned || entry.scanned;
    existing.coverageComplete =
      existing.coverageComplete === true && entry.coverageComplete === true;
    existing.routeGraphComplete =
      existing.routeGraphComplete === true && entry.routeGraphComplete === true;
  }
  report.coverage = {
    ...report.coverage,
    complete:
      report.coverage?.complete === true &&
      incoming.coverage.complete === true &&
      report.repositories.every((entry) => entry.coverageComplete === true),
    incompleteRepositories: [
      ...new Set([
        ...(report.coverage?.incompleteRepositories || []),
        ...incoming.coverage.incompleteRepositories,
        ...report.repositories
          .filter((entry) => entry.coverageComplete !== true)
          .map((entry) => entry.repository.fullName),
      ]),
    ],
  };
  summarize(report);
  return report;
}

/** Discover only explicit, shallow, optional interchange manifests. */
function importRenderBundles(input, warnings) {
  if (input.kind === "render-bundle") {
    const result = loadRenderBundle(input.file);
    input.value = result.report;
    input.sourceKind = input.kind;
    input.kind = "organization";
    warnings.push(...result.warnings);
    return;
  }
  if (input.kind !== "organization") return;
  const roots = new Set([input.root, input.discoveryRoot]);
  const children = fs.readdirSync(input.discoveryRoot, { withFileTypes: true });
  if (children.length > 20000) throw new Error("Render input has too many directory entries");
  for (const child of children)
    if (child.isDirectory() && !child.name.startsWith("."))
      roots.add(path.join(input.discoveryRoot, child.name));
  const files = [...roots]
    .map((root) => path.join(root, "render-bundle.json"))
    .filter((file) => fs.existsSync(file) && fs.lstatSync(file).isFile())
    .sort();
  if (files.length > 32)
    throw new Error("More than 32 optional render bundles; select a smaller input folder");
  if (!files.length) return;
  if (!input.value.organization?.login)
    throw new Error("Organization identity required for optional render bundles");
  const budget = { bytes: 0, references: 0 };
  const results = [];
  for (const file of files) {
    try {
      results.push(loadRenderBundle(file, { organization: input.value.organization, budget }));
    } catch (error) {
      warnings.push(
        `Optional render bundle skipped (${path.relative(input.discoveryRoot, file)}): ${String(error.message).split(input.discoveryRoot).join(".")}`,
      );
    }
  }
  // Validate the whole candidate set before merging, so duplicates cannot win by filename order.
  const key = (result) => `${result.manifest.producer.name}/${result.manifest.id}`;
  const counts = new Map();
  for (const result of results) counts.set(key(result), (counts.get(key(result)) || 0) + 1);
  for (const result of results) {
    const producer = result.manifest.producer.name;
    if (
      counts.get(key(result)) > 1 ||
      (producer === "gin-recon" && input.value.gin) ||
      producer === "express-recon"
    ) {
      warnings.push(`Optional render bundle skipped: duplicate source ${key(result)}`);
      continue;
    }
    warnings.push(...result.warnings);
    input.value = mergeBundle(input.value, result.report);
  }
}

function validateComplexity(value) {
  const stack = [[value, 0]];
  let nodes = 0;
  while (stack.length) {
    const [item, depth] = stack.pop();
    if (++nodes > 2_000_000 || depth > 64)
      throw new Error("Render bundle JSON complexity limit exceeded");
    if (item && typeof item === "object")
      for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
}

module.exports = { loadRenderBundle, importRenderBundles, LIMITS };

if (require.main === module) {
  try {
    if (!process.argv[2]) throw new Error("Usage: node src/render-bundle.js <render-bundle.json>");
    const result = loadRenderBundle(process.argv[2]);
    process.stdout.write(
      JSON.stringify({
        valid: result.warnings.length === 0,
        repositories: result.report.repositories.length,
        warnings: result.warnings,
      }) + "\n",
    );
    if (result.warnings.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
