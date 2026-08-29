"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const {
  inventory,
  buildReport,
  createMiddlewareReview,
  applyMiddlewareAssessments,
  validateAssessment,
} = require("../src/index");

const FIXTURE = path.join(__dirname, "fixtures", "static-app");
const CLI = path.join(__dirname, "..", "src", "cli.js");

function bundle() {
  const report = buildReport(inventory({ mode: "static", src: FIXTURE }), {
    command: "inventory",
    mode: "static",
    sourceRoot: FIXTURE,
  });
  return createMiddlewareReview(report, { root: FIXTURE });
}

function assessmentFor(review, candidate, overrides = {}) {
  return {
    schemaVersion: "1.0",
    bundleFingerprint: review.bundleFingerprint,
    assessments: [
      {
        candidateId: candidate.id,
        candidateFingerprint: candidate.fingerprint,
        classification: "authentication",
        enforcement: "always",
        confidence: "high",
        rationale: "The middleware rejects unauthenticated requests before calling next.",
        authGrant: { tags: ["authenticated"] },
        ...overrides,
      },
    ],
  };
}

test("builds deterministic, bounded middleware evidence with definitions and callsites", () => {
  const first = bundle();
  const second = bundle();
  assert.deepEqual(second, first);
  assert.match(first.untrustedSourceNotice, /untrusted evidence/);
  assert.equal(first.assessmentSchema.additionalProperties, false);
  assert.equal(first.evidenceCoverage.complete, true);
  assert.equal(first.evidenceCoverage.definitionSearch.complete, true);
  assert.ok(first.evidenceCoverage.definitionSearch.analyzed > 0);
  assert.equal(
    first.evidenceCoverage.definitionSearch.scope.fingerprint,
    first.evidenceCoverage.inventory.scope.fingerprint,
  );

  const auth = first.candidates.find((candidate) => candidate.name === "requireAuth");
  assert.ok(auth);
  assert.ok(auth.definitions.some((item) => item.source.file === "auth.js"));
  assert.ok(auth.callsites.some((item) => item.source.file === "app.js"));
  assert.ok(auth.sampleRoutes.some((route) => route.path === "/me"));
  assert.equal(auth.deterministicHints.likelyAuth, true);

  const parser = first.candidates.find((candidate) => candidate.name === "express.json");
  assert.equal(parser.deterministicHints.knownNonAuth, true);
  assert.ok(first.candidates.every((candidate) => candidate.rawExamples.length <= 5));
});

test("middleware review reports truncated definition evidence explicitly", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-review-coverage-"));
  try {
    fs.writeFileSync(path.join(root, "large.js"), " ".repeat(1025));
    const report = {
      mode: "static",
      routes: [
        {
          method: "GET",
          path: "/health",
          applicationId: "app:app.js#app",
          source: { file: "app.js", line: 1 },
          middlewares: [{ name: "guard", kind: "identifier", raw: "guard" }],
        },
      ],
      diagnostics: [],
    };
    const review = createMiddlewareReview(report, {
      root,
      scan: { maxFileBytes: 1024 },
    });
    assert.equal(review.evidenceCoverage.complete, false);
    assert.equal(review.evidenceCoverage.definitionSearch.failed, 1);
    assert.match(review.diagnostics.join("\n"), /exceeds scan\.maxFileBytes/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("hybrid bundles preserve static and runtime middleware disagreement", () => {
  const report = {
    mode: "hybrid",
    routes: [
      {
        method: "GET",
        path: "/hybrid",
        applicationId: "app:test#app",
        source: { file: "app.js", line: 10 },
        presence: "both",
        middlewares: [{ name: "runtimeGuard", kind: "identifier", raw: "runtimeGuard" }],
        observations: {
          static: {
            path: "/hybrid",
            source: { file: "app.js", line: 10 },
            middlewares: [{ name: "staticGuard", kind: "identifier", raw: "staticGuard" }],
          },
          runtime: {
            path: "/hybrid",
            source: { file: "app.js", line: 10 },
            middlewares: [{ name: "runtimeGuard", kind: "identifier", raw: "runtimeGuard" }],
          },
          conflicts: ["middleware-identity"],
        },
      },
    ],
    diagnostics: [],
  };
  const review = createMiddlewareReview(report, { root: FIXTURE });
  const staticallyObserved = review.candidates.find((item) => item.name === "staticGuard");
  const runtimeObserved = review.candidates.find((item) => item.name === "runtimeGuard");
  assert.deepEqual(staticallyObserved.sampleRoutes[0].observedBy, ["static"]);
  assert.deepEqual(runtimeObserved.sampleRoutes[0].observedBy, ["runtime"]);
  assert.deepEqual(staticallyObserved.hybridConflicts, ["middleware-identity"]);
});

test("validated assessments remain advisory and produce explicit config suggestions", () => {
  const review = bundle();
  const candidate = review.candidates.find((item) => item.name === "requireAuth");
  const result = applyMiddlewareAssessments(review, assessmentFor(review, candidate));
  assert.equal(result.advisory, true);
  assert.deepEqual(result.reviewedConfigSuggestions.authMiddleware.requireAuth, {
    tags: ["authenticated"],
  });
  assert.deepEqual(result.reviewedConfigSuggestions.authWrappers, []);
  assert.match(result.notice, /did not alter audit results/);
});

test("rejects stale, unknown, duplicate, and taxonomy-invalid assessments", () => {
  const review = bundle();
  const candidate = review.candidates.find((item) => item.name === "requireAuth");

  const staleBundle = assessmentFor(review, candidate);
  staleBundle.bundleFingerprint = "0".repeat(64);
  assert.throws(() => applyMiddlewareAssessments(review, staleBundle), /different or stale/);

  const staleCandidate = assessmentFor(review, candidate);
  staleCandidate.assessments[0].candidateFingerprint = "0".repeat(64);
  assert.throws(() => applyMiddlewareAssessments(review, staleCandidate), /fingerprint is stale/);

  const invalid = assessmentFor(review, candidate, { classification: "definitely-auth" });
  assert.throws(() => applyMiddlewareAssessments(review, invalid), /published taxonomy/);

  const duplicate = assessmentFor(review, candidate);
  duplicate.assessments.push({ ...duplicate.assessments[0] });
  assert.throws(() => applyMiddlewareAssessments(review, duplicate), /duplicated/);

  const unknown = assessmentFor(review, candidate);
  unknown.assessments[0].candidateId = "middleware:missing:0000000000000000";
  assert.throws(() => applyMiddlewareAssessments(review, unknown), /unknown candidate/);

  assert.throws(() => applyMiddlewareAssessments({}, duplicate), /not an express-recon/);
});

test("assessment validation fails closed on malformed contract fields", () => {
  const valid = {
    schemaVersion: "1.0",
    bundleFingerprint: "a".repeat(64),
    assessments: [
      {
        candidateId: "middleware:test",
        candidateFingerprint: "b".repeat(64),
        classification: "authentication",
        enforcement: "always",
        confidence: "high",
        rationale: "Reviewed behavior",
      },
    ],
  };
  const invalid = [
    null,
    { ...valid, unexpected: true },
    { ...valid, schemaVersion: "2.0" },
    { ...valid, bundleFingerprint: "short" },
    { ...valid, assessments: {} },
    { ...valid, assessments: [null] },
    { ...valid, assessments: [{ ...valid.assessments[0], unexpected: true }] },
    { ...valid, assessments: [{ ...valid.assessments[0], candidateId: "" }] },
    { ...valid, assessments: [{ ...valid.assessments[0], candidateFingerprint: "short" }] },
    { ...valid, assessments: [{ ...valid.assessments[0], enforcement: "sometimes" }] },
    { ...valid, assessments: [{ ...valid.assessments[0], confidence: "certain" }] },
    { ...valid, assessments: [{ ...valid.assessments[0], rationale: "" }] },
    { ...valid, assessments: [{ ...valid.assessments[0], transparentWrapper: "yes" }] },
    { ...valid, assessments: [{ ...valid.assessments[0], authGrant: [] }] },
    { ...valid, assessments: [{ ...valid.assessments[0], authGrant: { extra: [] } }] },
    { ...valid, assessments: [{ ...valid.assessments[0], authGrant: { tags: [""] } }] },
  ];
  for (const value of invalid) assert.throws(() => validateAssessment(value));
});

test("only eligible named guards and transparent wrappers become suggestions", () => {
  const review = bundle();
  const parser = review.candidates.find((item) => item.name === "express.json");
  const wrapper = review.candidates.find((item) => item.name === "logger");
  const assessment = {
    schemaVersion: "1.0",
    bundleFingerprint: review.bundleFingerprint,
    assessments: [
      {
        candidateId: parser.id,
        candidateFingerprint: parser.fingerprint,
        classification: "parsing",
        enforcement: "none",
        confidence: "high",
        rationale: "Body parser only",
      },
      {
        candidateId: wrapper.id,
        candidateFingerprint: wrapper.fingerprint,
        classification: "wrapper",
        enforcement: "always",
        confidence: "high",
        rationale: "Always delegates to the wrapped middleware",
        transparentWrapper: true,
      },
    ],
  };
  const result = applyMiddlewareAssessments(review, assessment);
  assert.deepEqual(result.reviewedConfigSuggestions.authWrappers, ["logger"]);
  assert.equal(
    result.suggestions.find((item) => item.name === "express.json").configSuggestion,
    null,
  );

  const anonymousBundle = {
    kind: "middleware-review-bundle",
    bundleFingerprint: "c".repeat(64),
    candidates: [{ id: "middleware:anonymous", name: "<anonymous>", fingerprint: "d".repeat(64) }],
  };
  const anonymous = applyMiddlewareAssessments(anonymousBundle, {
    schemaVersion: "1.0",
    bundleFingerprint: anonymousBundle.bundleFingerprint,
    assessments: [
      {
        candidateId: "middleware:anonymous",
        candidateFingerprint: "d".repeat(64),
        classification: "authentication",
        enforcement: "always",
        confidence: "high",
        rationale: "Appears to reject unauthenticated requests",
      },
    ],
  });
  assert.equal(anonymous.summary.configSuggestions, 0);
  assert.match(anonymous.warnings[0], /stable middleware name/);

  const prototypeBundle = {
    kind: "middleware-review-bundle",
    bundleFingerprint: "e".repeat(64),
    candidates: [{ id: "middleware:prototype", name: "__proto__", fingerprint: "f".repeat(64) }],
  };
  const prototypeResult = applyMiddlewareAssessments(prototypeBundle, {
    schemaVersion: "1.0",
    bundleFingerprint: prototypeBundle.bundleFingerprint,
    assessments: [
      {
        candidateId: "middleware:prototype",
        candidateFingerprint: "f".repeat(64),
        classification: "authentication",
        enforcement: "always",
        confidence: "high",
        rationale: "Always rejects unauthenticated requests",
      },
    ],
  });
  assert.equal(
    Object.hasOwn(prototypeResult.reviewedConfigSuggestions.authMiddleware, "__proto__"),
    true,
  );
  assert.deepEqual(prototypeResult.reviewedConfigSuggestions.authMiddleware.__proto__, {
    tags: ["authenticated"],
  });
});

test("review and import-review CLI commands form an offline round trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "express-recon-review-"));
  try {
    const review = JSON.parse(
      execFileSync("node", [CLI, "review-middleware", "--src", FIXTURE], {
        encoding: "utf8",
      }),
    );
    const candidate = review.candidates.find((item) => item.name === "requireAuth");
    const reviewFile = path.join(dir, "review.json");
    const assessmentFile = path.join(dir, "assessment.json");
    fs.writeFileSync(reviewFile, JSON.stringify(review));
    fs.writeFileSync(assessmentFile, JSON.stringify(assessmentFor(review, candidate)));

    const result = JSON.parse(
      execFileSync(
        "node",
        [CLI, "import-review", "--review", reviewFile, "--assessment", assessmentFile],
        { encoding: "utf8" },
      ),
    );
    assert.equal(result.kind, "middleware-review-suggestions");
    assert.equal(result.summary.configSuggestions, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
