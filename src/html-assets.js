"use strict";

const STYLES = `
:root {
  color-scheme: light dark;
  --accent: #d13f3f;
  --accent-soft: #fff0ef;
  --bg: #f6f7f9;
  --panel: #ffffff;
  --panel-muted: #f0f2f5;
  --ink: #111827;
  --muted: #3f4a59;
  --border: #d8dee4;
  --link: #9d2929;
  --good: #18794e;
  --good-soft: #dafbe8;
  --warn: #9a6700;
  --warn-soft: #fff8c5;
  --bad: #b42318;
  --bad-soft: #ffebe9;
  --info: #0969da;
  --info-soft: #ddf4ff;
  --shadow: 0 8px 28px rgb(31 35 40 / 8%);
}

@media (prefers-color-scheme: dark) {
  :root {
    --accent-soft: #3c2022;
    --bg: #0d1117;
    --panel: #161b22;
    --panel-muted: #21262d;
    --ink: #f3f6fa;
    --muted: #c2cad4;
    --border: #30363d;
    --link: #ff9b99;
    --good: #56d394;
    --good-soft: #173b2c;
    --warn: #eac54f;
    --warn-soft: #403719;
    --bad: #ff938a;
    --bad-soft: #482321;
    --info: #79c0ff;
    --info-soft: #142c44;
    --shadow: 0 8px 28px rgb(0 0 0 / 28%);
  }
}

* { box-sizing: border-box; }

html { background: var(--bg); }

body {
  margin: 0;
  color: var(--ink);
  background: var(--bg);
  font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

a { color: var(--link); }
a:hover { text-decoration-thickness: 2px; }
a:focus-visible, input:focus-visible, select:focus-visible, summary:focus-visible {
  outline: 3px solid color-mix(in srgb, var(--accent) 55%, transparent);
  outline-offset: 2px;
}

code, .mono {
  font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace;
  overflow-wrap: anywhere;
}

.shell { width: min(1440px, calc(100% - 32px)); margin: 0 auto; }

.site-header {
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--panel) 92%, transparent);
}

.site-header__inner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 64px;
  gap: 20px;
}

.brand {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  color: var(--ink);
  font-weight: 750;
  letter-spacing: -0.02em;
  text-decoration: none;
}

.brand__mark {
  width: 32px;
  height: 32px;
}

.reference-section { margin: 24px 0; }
.reference-section > summary { cursor: pointer; padding: 18px; font-weight: 700; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; }
.status-group th { background: var(--panel-muted); padding: 12px 16px; text-align: left; }
.evidence-json { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 400px; overflow: auto; }

.header-meta { color: var(--muted); font-size: 13px; text-align: right; }

main { padding: 42px 0 72px; }

.hero { margin-bottom: 26px; }
.eyebrow {
  margin: 0 0 8px;
  color: var(--accent);
  font-size: 12px;
  font-weight: 800;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1, h2, h3 { line-height: 1.2; letter-spacing: -0.025em; }
h1 { margin: 0; font-size: clamp(30px, 4vw, 48px); }
h2 { margin: 0; font-size: 22px; }
h3 { margin: 0; font-size: 16px; }
.lede { max-width: 850px; margin: 10px 0 0; color: var(--muted); font-size: 16px; }

.metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 12px;
  margin: 24px 0;
}

.metric, .panel {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--panel);
  box-shadow: var(--shadow);
}

.metric { padding: 16px; }
.metric__value { display: block; font-size: 25px; font-weight: 750; line-height: 1.1; }
.metric__label { display: block; margin-top: 6px; color: var(--muted); font-size: 12px; }
.metrics--summary { grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; }
.metric--summary { padding: 20px; box-shadow: none; }
.metric__heading { margin: 0 0 14px; font-size: 13px; font-weight: 650; color: var(--muted); letter-spacing: 0; }
.metric--summary .metric__value { font-size: clamp(24px, 2.4vw, 32px); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.metric__description { margin: 8px 0 18px; color: var(--muted); font-size: 12px; }
.metric__details { display: grid; gap: 9px; padding-top: 14px; margin: 0; border-top: 1px solid var(--border); font-size: 12px; }
.metric__details > div { display: flex; justify-content: space-between; gap: 12px; }
.metric__details dt { color: var(--muted); }
.metric__details dd { margin: 0; text-align: right; font-weight: 600; font-variant-numeric: tabular-nums; }
.docs-coverage { min-width: 165px; font-variant-numeric: tabular-nums; }
.docs-source { max-width: 240px; overflow-wrap: anywhere; }
.disclosure > summary { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 20px; cursor: pointer; list-style: none; }
.disclosure > summary::-webkit-details-marker { display: none; }
.disclosure > summary > span:first-child { display: grid; gap: 5px; }
.disclosure__action { color: var(--link); font-size: 13px; white-space: nowrap; }
.disclosure__action::after { content: "Show details +"; }
.disclosure[open] .disclosure__action::after { content: "Hide details −"; }
.disclosure[open] > summary { border-bottom: 1px solid var(--border); }

.panel { margin-top: 18px; overflow: hidden; }
.panel__head {
  display: flex;
  align-items: start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px;
  border-bottom: 1px solid var(--border);
}
.panel__body { padding: 20px; }
.panel__description { margin: 5px 0 0; color: var(--muted); }

.notice {
  margin: 18px 0;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-left: 5px solid var(--info);
  border-radius: 9px;
  background: var(--info-soft);
}
.notice--warn { border-left-color: var(--warn); background: var(--warn-soft); }
.notice--bad { border-left-color: var(--bad); background: var(--bad-soft); }
.notice strong { display: block; margin-bottom: 3px; }

.badge {
  display: inline-flex;
  align-items: center;
  justify-self: start;
  line-height: 1.25;
  min-height: 23px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--panel-muted);
  color: var(--ink);
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
}
.badge--good { border-color: color-mix(in srgb, var(--good) 45%, var(--border)); background: var(--good-soft); color: var(--good); }
.badge--warn { border-color: color-mix(in srgb, var(--warn) 45%, var(--border)); background: var(--warn-soft); color: var(--warn); }
.badge--bad { border-color: color-mix(in srgb, var(--bad) 45%, var(--border)); background: var(--bad-soft); color: var(--bad); }
.badge--info { border-color: color-mix(in srgb, var(--info) 45%, var(--border)); background: var(--info-soft); color: var(--info); }
.badge--accent { border-color: var(--accent); background: var(--accent-soft); color: var(--ink); }

.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: end;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
  background: var(--panel-muted);
}
.field { display: grid; gap: 5px; flex: 1 1 250px; min-width: 0; }
.field--domain { flex-basis: 220px; }
.field--compact { flex: 0 1 180px; min-width: 0; }
.field label { color: var(--muted); font-size: 12px; font-weight: 650; }
input, select {
  min-height: 38px;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 7px 10px;
  color: var(--ink);
  background: var(--panel);
  font: inherit;
  width: 100%;
  min-width: 0;
}
.result-count { margin-left: auto; padding-bottom: 8px; color: var(--muted); font-size: 13px; }

.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; }
th, td { padding: 12px 14px; border-bottom: 1px solid var(--border); text-align: left; vertical-align: top; }
th { color: var(--muted); background: var(--panel-muted); font-size: 11px; letter-spacing: 0.045em; text-transform: uppercase; }
tbody tr:last-child td { border-bottom: 0; }
tbody tr:hover { background: color-mix(in srgb, var(--accent-soft) 42%, transparent); }
tr[hidden] { display: none; }
.route-path { min-width: 220px; font-weight: 650; }
.middleware { min-width: 210px; color: var(--muted); }
.source { min-width: 160px; }
.method { font-weight: 800; letter-spacing: 0.035em; }
.subtle { color: var(--muted); font-size: 12px; }
.stack { display: grid; gap: 5px; }
.repository-status { width: 1%; white-space: nowrap; }
.repository-framework { min-width: 150px; }
.framework-badges { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.framework-role { max-width: 260px; overflow-wrap: anywhere; }

/* Keep the repository summary within its panel even for very long repo names. */
.repository-table-wrap > table { table-layout: fixed; }
.repository-table-wrap th, .repository-table-wrap td { padding: 12px 10px; overflow-wrap: anywhere; }
.repository-table-wrap td { font-size: 13px; }
.repository-table-wrap .stack, .repository-table-wrap .docs-coverage { min-width: 0; }
.repository-table-wrap .repository-status { width: auto; white-space: normal; }
.repository-table-wrap .repository-framework { min-width: 0; }
.repository-table-wrap .badge { max-width: 100%; white-space: normal; }
.repository-col-name { width: 28%; }
.repository-col-status { width: 11%; }
.repository-col-framework { width: 12%; }
.repository-col-apps { width: 6%; }
.repository-col-routes { width: 7%; }
.repository-col-domains { width: 12%; }
.repository-col-docs { width: 17%; }
.repository-table-wrap--domains .repository-col-name { width: 22%; }
.repository-table-wrap--reference .repository-col-name { width: 23%; }
.repository-table-wrap--reference.repository-table-wrap--domains .repository-col-name { width: 20%; }
.repository-table-wrap--reference .repository-col-framework { width: 10%; }
.repository-table-wrap--reference .repository-col-apps { width: 5%; }
.repository-table-wrap--reference .repository-col-routes { width: 6%; }
.repository-table-wrap--reference .repository-col-domains { width: 11%; }
.repository-table-wrap--reference .repository-col-docs { width: 14%; }
.repository-table-wrap--reference .repository-col-coverage { width: 10%; }

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 12px; }
.card { padding: 15px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel-muted); }
.card p { margin: 7px 0 0; color: var(--muted); }

.plain-list { margin: 0; padding-left: 20px; }
.plain-list li + li { margin-top: 7px; }
.key-values { display: grid; grid-template-columns: minmax(130px, 0.3fr) 1fr; gap: 8px 16px; margin: 0; }
.key-values dt { color: var(--muted); }
.key-values dd { margin: 0; overflow-wrap: anywhere; }
.invalid-specification-repository { border-top: 1px solid var(--border); margin-top: 12px; }
.invalid-specification-repository > summary { cursor: pointer; padding: 12px 0; font-weight: 700; }
.invalid-specification-repository > details { margin: 0 0 12px 16px; }
.invalid-specification-repository > details > summary { cursor: pointer; padding: 8px 0; }
.specification-diagnostic { padding: 8px 12px; background: var(--panel-muted); border-radius: 8px; margin-top: 8px; overflow-wrap: anywhere; }
.specification-diagnostic li + li { margin-top: 12px; }
.empty { margin: 0; color: var(--muted); font-style: italic; }

.site-footer { padding: 24px 0 42px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }

@media (max-width: 1100px) {
  .metrics--summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}

@media screen and (max-width: 1000px) {
  .repository-table-wrap > table, .repository-table-wrap tbody { display: block; width: 100%; }
  .repository-table-wrap colgroup { display: none; }
  .repository-table-wrap thead { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
  .repository-table-wrap tbody tr:not(.status-group) { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 20px; padding: 18px; border-bottom: 1px solid var(--border); }
  .repository-table-wrap td { display: block; padding: 0; border: 0; min-width: 0; }
  .repository-table-wrap td:first-child, .repository-table-wrap td:last-child { grid-column: 1 / -1; }
  .repository-table-wrap td::before { content: attr(data-label); display: block; margin-bottom: 5px; color: var(--muted); font-size: 11px; font-weight: 650; }
  .repository-table-wrap td:first-child::before { display: none; }
  .repository-table-wrap td:first-child strong { font-size: 15px; }
  .repository-table-wrap .status-group, .repository-table-wrap .status-group th { display: block; width: 100%; }
  .repository-table-wrap tbody tr[hidden] { display: none; }
}

@media (max-width: 720px) {
  .shell { width: min(100% - 20px, 1440px); }
  main { padding-top: 28px; }
  .site-header__inner { align-items: flex-start; padding: 13px 0; }
  .header-meta { max-width: 50%; }
  .panel__head { display: block; }
  .filters { align-items: stretch; }
  .field, .field--compact { flex-basis: 100%; min-width: 0; }
  .result-count { margin-left: 0; }
  .key-values { grid-template-columns: 1fr; gap: 2px; }
  .key-values dd + dt { margin-top: 10px; }
}

@media (max-width: 440px) {
  .metrics--summary { grid-template-columns: 1fr; }
}

@media print {
  :root { --bg: #fff; --panel: #fff; --ink: #000; --muted: #444; --border: #bbb; }
  .filters, .site-footer { display: none; }
  .shell { width: 100%; }
  .metric, .panel { box-shadow: none; break-inside: avoid; }
  tr[hidden] { display: table-row; }
}
`;

// Swagger UI ships a light palette. Declaring support for a browser-managed
// dark scheme changes the page canvas and native controls without changing all
// Swagger UI text colors, so dark-system browsers can produce dark-on-dark
// content. Keep API references explicitly light and give the canvas stable,
// high-contrast colors regardless of the host preference.
const OPENAPI_STYLES = `
:root {
  color-scheme: only light;
  --openapi-page: #f6f8fa;
  --openapi-surface: #ffffff;
  --openapi-ink: #1f2328;
}

html,
body {
  min-height: 100%;
  margin: 0;
  color: var(--openapi-ink);
  background: var(--openapi-page);
}

#swagger-ui {
  min-height: 100vh;
  background: var(--openapi-surface);
}

.swagger-ui,
.swagger-ui button,
.swagger-ui input,
.swagger-ui select,
.swagger-ui textarea {
  color-scheme: light;
}

noscript {
  display: block;
  margin: 24px;
  padding: 16px;
  border: 1px solid #d0d7de;
  border-radius: 8px;
  color: var(--openapi-ink);
  background: var(--openapi-surface);
  font: 15px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

@media print {
  :root {
    --openapi-page: #ffffff;
  }
}
`;

const SCRIPT = `
"use strict";

for (const controls of document.querySelectorAll("[data-filter-controls]")) {
  const table = document.getElementById(controls.dataset.filterControls);
  if (!table) continue;
  const rows = [...table.querySelectorAll("tbody tr[data-search]:not(.status-group)")];
  const search = controls.querySelector("[data-filter-search]");
  const status = controls.querySelector("[data-filter-status]");
  const framework = controls.querySelector("[data-filter-framework]");
  const domain = controls.querySelector("[data-filter-domain]");
  const sortCandidate = controls.querySelector("[data-sort]");
  const sorter = sortCandidate?.dataset.sort === "true" ? sortCandidate : null;
  const count = controls.querySelector("[data-result-count]");

  const sortRows = () => {
    if (!sorter) return;
    const tbody = table.querySelector("tbody");
    if (!tbody) return;
    const groups = [...table.querySelectorAll("tbody tr.status-group")];
    const groupOrder = new Map(groups.map((group, index) => [group.dataset.status, index]));
    const mode = sorter.value;
    const sorted = rows.slice().sort((left, right) => {
      const byGroup = (groupOrder.get(left.dataset.status) ?? 0) - (groupOrder.get(right.dataset.status) ?? 0);
      if (byGroup) return byGroup;
      if (mode === "name-asc") return (left.dataset.sortName || "").localeCompare(right.dataset.sortName || "");
      const field = mode.startsWith("apps-") ? "sortApps" : "sortRoutes";
      const difference = Number(left.dataset[field] || 0) - Number(right.dataset[field] || 0);
      if (difference) return mode.endsWith("-asc") ? difference : -difference;
      return (left.dataset.sortName || "").localeCompare(right.dataset.sortName || "");
    });
    if (!groups.length) {
      for (const row of sorted) tbody.append(row);
      return;
    }
    for (const group of groups) {
      tbody.append(group);
      for (const row of sorted) if (row.dataset.status === group.dataset.status) tbody.append(row);
    }
  };

  const update = () => {
    sortRows();
    const query = (search?.value || "").trim().toLowerCase();
    const selected = status?.value || "";
    const selectedFramework = framework?.value || "";
    const domainQuery = (domain?.value || "").trim().toLowerCase();
    let visible = 0;
    for (const row of rows) {
      const matchesQuery = !query || row.dataset.search.includes(query);
      const matchesStatus = !selected || row.dataset.status === selected;
      const matchesFramework = !selectedFramework || (row.dataset.frameworks || "").split(" ").includes(selectedFramework);
      const matchesDomain = !domainQuery || (row.dataset.domains || "").includes(domainQuery);
      row.hidden = !(matchesQuery && matchesStatus && matchesFramework && matchesDomain);
      if (!row.hidden) visible++;
    }
    if (count) count.textContent = visible + " of " + rows.length;
    for (const group of table.querySelectorAll("tbody tr.status-group")) {
      group.hidden = !rows.some((row) => !row.hidden && row.dataset.status === group.dataset.status);
    }
  };

  search?.addEventListener("input", update);
  status?.addEventListener("change", update);
  framework?.addEventListener("change", update);
  domain?.addEventListener("input", update);
  sorter?.addEventListener("change", update);
  update();
}
`;

module.exports = { OPENAPI_STYLES, SCRIPT, STYLES };
