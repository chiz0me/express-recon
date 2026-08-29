#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOGO_DIR = path.join(ROOT, "assets", "logo");
const SOCIAL_PREVIEW = path.join(ROOT, "assets", "social-preview.png");
const SOURCE_FILES = ["mark.svg", "lockup.svg", "tile.svg"];
const MODES = ["light", "dark"];

function usage() {
  return [
    "Usage: node scripts/build-logo-variants.mjs [--check] [--social-preview]",
    "",
    "Builds static light and dark SVG variants from the responsive source SVGs.",
    "Pass --check to verify committed SVG variants without writing files.",
    "Pass --social-preview to also render assets/social-preview.png.",
  ].join("\n");
}

function extractDarkMedia(css, sourceName) {
  const mediaPattern = /@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)\s*\{/gi;
  const media = mediaPattern.exec(css);
  if (!media) throw new Error(`${sourceName}: missing dark color-scheme media rule`);
  if (mediaPattern.exec(css))
    throw new Error(`${sourceName}: multiple dark media rules are unsupported`);

  const open = css.indexOf("{", media.index);
  let depth = 1;
  let close = -1;
  for (let index = open + 1; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) {
      close = index;
      break;
    }
  }
  if (close === -1) throw new Error(`${sourceName}: unterminated dark media rule`);

  return {
    base: `${css.slice(0, media.index)}${css.slice(close + 1)}`,
    dark: css.slice(open + 1, close),
  };
}

function parseRules(css, sourceName, scope) {
  const rules = new Map();
  const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rulePattern = /\.([A-Za-z_][\w-]*)\s*\{([^{}]*)\}/g;
  let match;
  let remainder = withoutComments;

  while ((match = rulePattern.exec(withoutComments))) {
    const declarations = rules.get(match[1]) || new Map();
    for (const declaration of match[2].split(";")) {
      const trimmed = declaration.trim();
      if (!trimmed) continue;
      const colon = trimmed.indexOf(":");
      if (colon === -1) throw new Error(`${sourceName}: invalid ${scope} declaration ${trimmed}`);
      const property = trimmed.slice(0, colon).trim();
      const value = trimmed.slice(colon + 1).trim();
      if (!/^[a-z][a-z0-9-]*$/i.test(property) || !value) {
        throw new Error(`${sourceName}: invalid ${scope} declaration ${trimmed}`);
      }
      declarations.set(property, value);
    }
    rules.set(match[1], declarations);
    remainder = remainder.replace(match[0], "");
  }

  if (remainder.trim()) {
    throw new Error(`${sourceName}: unsupported CSS in ${scope}: ${remainder.trim()}`);
  }
  return rules;
}

function resolvedRules(baseRules, darkRules, mode) {
  const resolved = new Map();
  for (const [className, declarations] of baseRules) {
    resolved.set(className, new Map(declarations));
  }
  if (mode === "dark") {
    for (const [className, declarations] of darkRules) {
      const combined = resolved.get(className) || new Map();
      for (const [property, value] of declarations) combined.set(property, value);
      resolved.set(className, combined);
    }
  }
  return resolved;
}

function escapeAttribute(value) {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function setAttribute(attributes, name, value) {
  const existing = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*(?:"[^"]*"|'[^']*')`, "i");
  return `${attributes.replace(existing, "")} ${name}="${escapeAttribute(value)}"`;
}

function inlineClassRules(svg, rules, sourceName, mode) {
  return svg.replace(/<([A-Za-z][\w:.-]*)([^<>]*?)(\/?)>/g, (tag, name, attributes, slash) => {
    const classMatch = attributes.match(/\sclass\s*=\s*(["'])(.*?)\1/i);
    if (!classMatch) return tag;

    const classNames = classMatch[2].trim().split(/\s+/).filter(Boolean);
    let nextAttributes = attributes.replace(classMatch[0], "");
    for (const className of classNames) {
      const declarations = rules.get(className);
      if (!declarations) {
        throw new Error(`${sourceName}: no ${mode} declarations found for .${className}`);
      }
      for (const [property, value] of declarations) {
        nextAttributes = setAttribute(nextAttributes, property, value);
      }
    }
    return `<${name}${nextAttributes}${slash}>`;
  });
}

function buildVariant(source, sourceName, mode) {
  const styleMatch = source.match(/[ \t]*<style\b[^>]*>([\s\S]*?)<\/style>[ \t]*\r?\n?/i);
  if (!styleMatch) throw new Error(`${sourceName}: expected exactly one internal <style> block`);
  const remainingStyles = source.slice(styleMatch.index + styleMatch[0].length);
  if (/<style\b/i.test(remainingStyles)) {
    throw new Error(`${sourceName}: multiple <style> blocks are unsupported`);
  }

  const media = extractDarkMedia(styleMatch[1], sourceName);
  const baseRules = parseRules(media.base, sourceName, "light rules");
  const darkRules = parseRules(media.dark, sourceName, "dark rules");
  const withoutStyle = source.replace(styleMatch[0], "");
  const output = inlineClassRules(
    withoutStyle,
    resolvedRules(baseRules, darkRules, mode),
    sourceName,
    mode,
  );

  if (/<style\b|@media\b|\sclass\s*=/i.test(output)) {
    throw new Error(`${sourceName}: generated ${mode} variant retains responsive styling`);
  }
  if (!/<svg\b[^>]*\bviewBox\s*=/i.test(output)) {
    throw new Error(`${sourceName}: generated ${mode} variant is missing a viewBox`);
  }
  return `${output.trim()}\n`;
}

function rootSvg(svg, sourceName) {
  const match = svg.match(/^\s*<svg\b([^>]*)>([\s\S]*)<\/svg>\s*$/i);
  if (!match) throw new Error(`${sourceName}: cannot read root SVG element`);
  const viewBoxMatch = match[1].match(/\bviewBox\s*=\s*(["'])(.*?)\1/i);
  if (!viewBoxMatch) throw new Error(`${sourceName}: missing viewBox`);
  const viewBox = viewBoxMatch[2]
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (viewBox.length !== 4 || viewBox.some((value) => !Number.isFinite(value))) {
    throw new Error(`${sourceName}: invalid viewBox`);
  }
  return { body: match[2], viewBox };
}

async function buildSocialPreview(lockup) {
  const canvasWidth = 1280;
  const canvasHeight = 640;
  const markHeight = 128;
  const { body, viewBox } = rootSvg(lockup, "lockup-light.svg");
  const logoWidth = (viewBox[2] / viewBox[3]) * markHeight;
  const x = (canvasWidth - logoWidth) / 2;
  const y = (canvasHeight - markHeight) / 2;
  const composition = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}" viewBox="0 0 ${canvasWidth} ${canvasHeight}">`,
    `  <rect width="${canvasWidth}" height="${canvasHeight}" fill="#FFFFFF"/>`,
    `  <svg x="${x}" y="${y}" width="${logoWidth}" height="${markHeight}" viewBox="${viewBox.join(" ")}">${body}</svg>`,
    "</svg>",
  ].join("\n");

  const { Resvg } = await import("@resvg/resvg-js");
  const png = new Resvg(composition).render().asPng();
  if (png.readUInt32BE(16) !== canvasWidth || png.readUInt32BE(20) !== canvasHeight) {
    throw new Error("social preview renderer returned unexpected dimensions");
  }
  await fs.writeFile(SOCIAL_PREVIEW, png);
  process.stdout.write(`wrote ${path.relative(ROOT, SOCIAL_PREVIEW)}\n`);
}

async function main() {
  const flags = new Set(process.argv.slice(2));
  if (flags.delete("--help") || flags.delete("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const withSocialPreview = flags.delete("--social-preview");
  const check = flags.delete("--check");
  if (flags.size) throw new Error(`unknown option: ${[...flags].join(", ")}\n${usage()}`);

  await fs.mkdir(LOGO_DIR, { recursive: true });
  const variants = new Map();
  for (const sourceName of SOURCE_FILES) {
    const sourcePath = path.join(LOGO_DIR, sourceName);
    const source = await fs.readFile(sourcePath, "utf8");
    for (const mode of MODES) {
      const outputName = sourceName.replace(/\.svg$/i, `-${mode}.svg`);
      const output = buildVariant(source, sourceName, mode);
      const outputPath = path.join(LOGO_DIR, outputName);
      if (check) {
        const committed = await fs.readFile(outputPath, "utf8").catch(() => "");
        if (committed !== output) {
          throw new Error(`assets/logo/${outputName} is stale; run npm run logo:build`);
        }
      } else {
        await fs.writeFile(outputPath, output);
      }
      variants.set(outputName, output);
      process.stdout.write(`${check ? "verified" : "wrote"} assets/logo/${outputName}\n`);
    }
  }

  if (withSocialPreview) await buildSocialPreview(variants.get("lockup-light.svg"));
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
