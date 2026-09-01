"use strict";

const FRAMEWORK_NAMES = Object.freeze(["express", "fastify", "nestjs"]);
const FRAMEWORK_SET = new Set(FRAMEWORK_NAMES);
const FRAMEWORK_REPOSITORY_STATUSES = Object.freeze([...FRAMEWORK_NAMES, "multi-framework"]);
const COMPLETE_REPOSITORY_STATUSES = new Set([...FRAMEWORK_REPOSITORY_STATUSES, "not-express"]);

function frameworkName(value) {
  return FRAMEWORK_SET.has(value) ? value : "express";
}

function statusForFrameworks(names) {
  const normalized = [...new Set(names.filter((name) => FRAMEWORK_SET.has(name)))].sort();
  if (normalized.length === 0) return "not-express";
  if (normalized.length === 1) return normalized[0];
  return "multi-framework";
}

function isFrameworkStatus(status) {
  return FRAMEWORK_REPOSITORY_STATUSES.includes(status);
}

module.exports = {
  COMPLETE_REPOSITORY_STATUSES,
  FRAMEWORK_NAMES,
  FRAMEWORK_REPOSITORY_STATUSES,
  frameworkName,
  isFrameworkStatus,
  statusForFrameworks,
};
