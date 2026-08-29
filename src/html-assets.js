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
  width: 18px;
  height: 18px;
  border: 5px solid var(--accent);
  border-radius: 5px;
  transform: rotate(45deg);
}

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
.field { display: grid; gap: 5px; min-width: min(320px, 100%); }
.field--compact { min-width: 180px; }
.field label { color: var(--muted); font-size: 12px; font-weight: 650; }
input, select {
  min-height: 38px;
  border: 1px solid var(--border);
  border-radius: 7px;
  padding: 7px 10px;
  color: var(--ink);
  background: var(--panel);
  font: inherit;
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

.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(245px, 1fr)); gap: 12px; }
.card { padding: 15px; border: 1px solid var(--border); border-radius: 9px; background: var(--panel-muted); }
.card p { margin: 7px 0 0; color: var(--muted); }

.plain-list { margin: 0; padding-left: 20px; }
.plain-list li + li { margin-top: 7px; }
.key-values { display: grid; grid-template-columns: minmax(130px, 0.3fr) 1fr; gap: 8px 16px; margin: 0; }
.key-values dt { color: var(--muted); }
.key-values dd { margin: 0; overflow-wrap: anywhere; }
.empty { margin: 0; color: var(--muted); font-style: italic; }

.site-footer { padding: 24px 0 42px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }

@media (max-width: 720px) {
  .shell { width: min(100% - 20px, 1440px); }
  main { padding-top: 28px; }
  .site-header__inner { align-items: flex-start; padding: 13px 0; }
  .header-meta { max-width: 50%; }
  .panel__head { display: block; }
  .filters { align-items: stretch; }
  .field, .field--compact { min-width: 100%; }
  .result-count { margin-left: 0; }
  .key-values { grid-template-columns: 1fr; gap: 2px; }
  .key-values dd + dt { margin-top: 10px; }
}

@media print {
  :root { --bg: #fff; --panel: #fff; --ink: #000; --muted: #444; --border: #bbb; }
  .filters, .site-footer { display: none; }
  .shell { width: 100%; }
  .metric, .panel { box-shadow: none; break-inside: avoid; }
  tr[hidden] { display: table-row; }
}
`;

const SCRIPT = `
"use strict";

for (const controls of document.querySelectorAll("[data-filter-controls]")) {
  const table = document.getElementById(controls.dataset.filterControls);
  if (!table) continue;
  const rows = [...table.querySelectorAll("tbody tr[data-search]")];
  const search = controls.querySelector("[data-filter-search]");
  const status = controls.querySelector("[data-filter-status]");
  const count = controls.querySelector("[data-result-count]");

  const update = () => {
    const query = (search?.value || "").trim().toLowerCase();
    const selected = status?.value || "";
    let visible = 0;
    for (const row of rows) {
      const matchesQuery = !query || row.dataset.search.includes(query);
      const matchesStatus = !selected || row.dataset.status === selected;
      row.hidden = !(matchesQuery && matchesStatus);
      if (!row.hidden) visible++;
    }
    if (count) count.textContent = visible + " of " + rows.length;
  };

  search?.addEventListener("input", update);
  status?.addEventListener("change", update);
  update();
}
`;

module.exports = { SCRIPT, STYLES };
