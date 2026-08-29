"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Resvg } = require("@resvg/resvg-js");

const ROOT = path.join(__dirname, "..");
const LOGO_DIR = path.join(ROOT, "assets", "logo");
const BUILD_SCRIPT = path.join(ROOT, "scripts", "build-logo-variants.mjs");
const SOURCE_NAMES = ["lockup", "mark", "tile"];
const EXPECTED_FILES = SOURCE_NAMES.flatMap((name) => [
  `${name}.svg`,
  `${name}-light.svg`,
  `${name}-dark.svg`,
]).sort();

function assertNoExternalReferences(svg, filename) {
  for (const match of svg.matchAll(/\b(?:href|xlink:href)\s*=\s*(["'])(.*?)\1/gi)) {
    assert.match(match[2], /^#/, `${filename} has an external href: ${match[2]}`);
  }
  for (const match of svg.matchAll(/\burl\(\s*(["']?)(.*?)\1\s*\)/gi)) {
    assert.match(match[2], /^#/, `${filename} has an external URL: ${match[2]}`);
  }
  assert.doesNotMatch(svg, /<\?xml-stylesheet\b/i, `${filename} has an external stylesheet`);
  assert.doesNotMatch(svg, /<!DOCTYPE\b/i, `${filename} has a doctype or external entity`);
}

test("logo SVGs are complete, safe, and parseable", () => {
  const files = fs
    .readdirSync(LOGO_DIR)
    .filter((filename) => filename.endsWith(".svg"))
    .sort();
  assert.deepEqual(files, EXPECTED_FILES);

  for (const filename of files) {
    const svg = fs.readFileSync(path.join(LOGO_DIR, filename), "utf8");
    assert.match(svg, /<svg\b[^>]*\bviewBox\s*=\s*(["'])[^"']+\1/i, `${filename} lacks a viewBox`);
    assert.doesNotMatch(svg, /<\s*script\b/i, `${filename} contains a script`);
    assertNoExternalReferences(svg, filename);
    assert.doesNotThrow(() => new Resvg(svg).render(), `${filename} is not a parseable SVG`);

    if (/-(?:light|dark)\.svg$/.test(filename)) {
      assert.doesNotMatch(
        svg,
        /<style\b|@media\b|\sclass\s*=/i,
        `${filename} is not fully inlined`,
      );
    }
  }
});

test("committed logo variants match their responsive sources", () => {
  const result = spawnSync(process.execPath, [BUILD_SCRIPT, "--check"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test("brand SVGs use the fixed red accent", () => {
  const files = [
    path.join(ROOT, "assets", "favicon.svg"),
    ...EXPECTED_FILES.map((filename) => path.join(LOGO_DIR, filename)),
  ];
  for (const file of files) {
    const svg = fs.readFileSync(file, "utf8");
    assert.match(svg, /#D13F3F/i, `${path.basename(file)} lacks the brand accent`);
    assert.doesNotMatch(svg, /#E24B4A/i, `${path.basename(file)} retains the pale red accent`);
    assert.doesNotMatch(svg, /#EF9F27/i, `${path.basename(file)} retains the old amber accent`);
  }
});

test("favicon uses the current tile geometry", () => {
  const tile = fs.readFileSync(path.join(LOGO_DIR, "tile.svg"), "utf8");
  const favicon = fs.readFileSync(path.join(ROOT, "assets", "favicon.svg"), "utf8");
  assert.equal(favicon.replace('width="32" height="32"', 'width="64" height="64"'), tile);
  assert.doesNotThrow(() => new Resvg(favicon).render(), "favicon.svg is not a parseable SVG");
});

test("social preview is a 1280 by 640 PNG", () => {
  const png = fs.readFileSync(path.join(ROOT, "assets", "social-preview.png"));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 1280);
  assert.equal(png.readUInt32BE(20), 640);
});
