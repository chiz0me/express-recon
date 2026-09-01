"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  MAX_REPOSITORY_DETAILS,
  compareOrganizationReports,
  loadOrganizationSnapshot,
  referencedRepositoryScan,
} = require("../src/organization-compare");

function route(method, routePath, authStatus = "proven") {
  return {
    applicationId: "app:src/app.js#app",
    method,
    path: routePath,
    authStatus,
    middlewares: [],
    tags: [],
    roles: [],
    scopes: [],
    source: { file: "src/app.js", line: 1 },
  };
}

function scan(routes) {
  return {
    kind: "repository-scan",
    inventory: {
      schemaVersion: "2.0",
      command: "audit",
      routes,
      findings: [],
      scanCoverage: { complete: true, scope: { fingerprint: "repo-scope" } },
    },
  };
}

function entry(name, routes, overrides = {}) {
  return {
    repository: { name, fullName: `acme/${name}` },
    status: routes.length ? "express" : "not-express",
    commit: overrides.commit || "a".repeat(40),
    coverageComplete: true,
    express: {
      applicationCount: routes.length ? 1 : 0,
      routeCount: routes.length,
      documentation: { reconciliationStatus: overrides.documentationStatus || "merged" },
    },
    scan: scan(routes),
    ...overrides,
  };
}

function organization(repositories, overrides = {}) {
  return {
    schemaVersion: "1.0",
    tool: "express-recon",
    toolVersion: "0.8.0",
    kind: "github-organization-inventory",
    organization: { login: "acme" },
    scope: {
      fingerprint: "organization-scope",
      includeArchived: false,
      includeForks: false,
      maxRepositories: 100,
      configHash: "config",
      scanHash: "scan",
    },
    coverage: { complete: true },
    summary: { routes: repositories.reduce((total, item) => total + item.express.routeCount, 0) },
    repositories,
    ...overrides,
  };
}

test("organization comparison reports repository, route, auth, and documentation changes", () => {
  const before = organization([
    entry("api", [route("GET", "/stable"), route("GET", "/removed")]),
    entry("retired", []),
    entry("gone", []),
  ]);
  const after = organization([
    entry("api", [route("GET", "/stable", "public"), route("POST", "/added")], {
      commit: "b".repeat(40),
      documentationStatus: "needs-input",
    }),
    entry("retired", [route("GET", "/health")], { commit: "b".repeat(40) }),
    entry("new-repository", [], { commit: "b".repeat(40) }),
  ]);
  const delta = compareOrganizationReports(before, after, {
    loadBaselineScan: (item) => item.scan,
    loadCurrentScan: (item) => item.scan,
  });

  assert.equal(delta.kind, "github-organization-inventory-delta");
  assert.equal(delta.coverage.complete, true);
  assert.deepEqual(
    {
      repositoriesAdded: delta.summary.repositoriesAdded,
      repositoriesRemoved: delta.summary.repositoriesRemoved,
      repositoriesChanged: delta.summary.repositoriesChanged,
      repositoryStatusChanges: delta.summary.repositoryStatusChanges,
      newlyExpressRepositories: delta.summary.newlyExpressRepositories,
      addedRoutes: delta.summary.addedRoutes,
      removedRoutes: delta.summary.removedRoutes,
      authRegressions: delta.summary.authRegressions,
    },
    {
      repositoriesAdded: 1,
      repositoriesRemoved: 1,
      repositoriesChanged: 4,
      repositoryStatusChanges: 1,
      newlyExpressRepositories: 1,
      addedRoutes: 2,
      removedRoutes: 1,
      authRegressions: 1,
    },
  );
  const api = delta.repositories.find((item) => item.repository.fullName === "acme/api");
  assert.equal(api.changes.documentationChanged, true);
  assert.equal(api.changes.routes.summary.authRegressions, 1);
  assert.equal(api.changes.routes.details.authRegressions[0].path, "/stable");
  assert.equal(delta.diagnostics.length, 0);
});

test("organization comparison keeps exact counts while bounding retained route details", () => {
  const routes = Array.from({ length: MAX_REPOSITORY_DETAILS + 25 }, (_, index) =>
    route("GET", `/new-${index}`),
  );
  const before = organization([entry("api", [])]);
  const after = organization([entry("api", routes, { commit: "b".repeat(40), status: "express" })]);
  const delta = compareOrganizationReports(before, after, {
    loadBaselineScan: (item) => item.scan,
    loadCurrentScan: (item) => item.scan,
  });
  const api = delta.repositories[0];
  assert.equal(delta.summary.addedRoutes, routes.length);
  assert.equal(api.changes.routes.detailsRetained, MAX_REPOSITORY_DETAILS);
  assert.equal(api.changes.routes.detailsTruncated, true);
  assert.equal(api.changes.routes.details.addedRoutes.length, MAX_REPOSITORY_DETAILS);
});

test("organization comparison rejects mismatched scope and marks missing details incomplete", () => {
  const before = organization([entry("api", [route("GET", "/before")])]);
  const after = organization([entry("api", [route("GET", "/after")], { commit: "b".repeat(40) })]);
  const incomplete = compareOrganizationReports(before, after);
  assert.equal(incomplete.coverage.complete, false);
  assert.equal(incomplete.summary.exactComparisonFailures, 1);
  assert.deepEqual(incomplete.coverage.incompleteRepositories, ["acme/api"]);
  assert.match(incomplete.diagnostics[0], /detailed repository artifacts/);

  assert.throws(
    () =>
      compareOrganizationReports(before, {
        ...after,
        scope: { ...after.scope, fingerprint: "different" },
      }),
    /scopes differ/,
  );
  assert.throws(
    () =>
      compareOrganizationReports(before, {
        ...after,
        organization: { login: "another-org" },
      }),
    /does not match/,
  );
});

test("organization snapshot loading contains detailed artifacts to its output directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-org-delta-"));
  const outside = `${root}-outside.json`;
  try {
    const report = organization([
      {
        ...entry("api", [route("GET", "/health")]),
        scan: undefined,
        artifacts: { repositoryScan: "repositories/api/repo-scan.json" },
      },
    ]);
    fs.mkdirSync(path.join(root, "repositories", "api"), { recursive: true });
    fs.writeFileSync(path.join(root, "organization-inventory.json"), JSON.stringify(report));
    fs.writeFileSync(
      path.join(root, "repositories", "api", "repo-scan.json"),
      JSON.stringify(scan([route("GET", "/health")])),
    );
    const snapshot = loadOrganizationSnapshot(root);
    assert.equal(
      referencedRepositoryScan(snapshot, report.repositories[0]).kind,
      "repository-scan",
    );

    fs.writeFileSync(outside, JSON.stringify(scan([])));
    fs.rmSync(path.join(root, "repositories", "api", "repo-scan.json"));
    fs.symlinkSync(outside, path.join(root, "repositories", "api", "repo-scan.json"));
    assert.throws(
      () => referencedRepositoryScan(snapshot, report.repositories[0]),
      /symlink escapes/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { force: true });
  }
});
