// Tests for the hover's rendered HTML.
//
// node --test, no test framework. The extension compiles to CommonJS and the
// vscode surface the hover path touches is MarkdownString plus one config
// read, so a small stub through Module._load renders the real tooltip()
// offline.
// That keeps this to one file and zero dependencies, which is the whole
// reason it exists rather than a vitest setup.
//
// What it guards is the geometry and the escaping — the things that are
// invisible in review and that only showed up here as screenshots:
// columns that must sum to TABLE_W, a row that must be centered, the TOP
// FINDINGS line and its icon, and break hints that must not reach the data.
const test = require("node:test");
const assert = require("node:assert");
const Module = require("node:module");

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "vscode") {
    return {
      MarkdownString: class {
        constructor(value) {
          this.value = value;
        }
      },
      // cli.config() reads settings; every caller passes a default, so
      // handing the default straight back gives the shipped behavior.
      workspace: { getConfiguration: () => ({ get: (_k, dflt) => dflt }) },
    };
  }
  return orig.apply(this, arguments);
};

const { tooltip } = require("../out/extension.js");

// The CLI's AIM JSON, schema kaimon/2.
const group = (over) => ({
  risk_severity: "LOW",
  risk_category: "SESSION_CACHE",
  agent: "claude",
  process: "bash",
  user: "dirk",
  files: 3,
  count: 9,
  common_path: "/home/dirk/",
  file_pattern: "*.{jsonl,json,sh}",
  first_seen: "2026-09-21T10:00:00Z",
  last_seen: "2026-09-21T10:30:00Z",
  ...over,
});

// severity_counts is derived from the groups the way the CLI derives it — logs
// per severity — so a test that only sets groups still gets a consistent
// strip, as a real report would.
const report = (over = {}) => {
  const r = {
    meta: { host: "ubu26", start_time: "2026-09-21T10:00:00Z", end_time: "2026-09-21T11:00:00Z" },
    kpi: { agents: 1, file_changes: 9, files: 3, file_changes_risk: 2 },
    grouped_file_changes_risk: [group()],
    grouped_file_changes_routine: [],
    grouped_file_changes_risk_total: 1,
    ...over,
  };
  if (!r.severity_counts) {
    r.severity_counts = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((name) => ({
      name,
      count: r.grouped_file_changes_risk.filter((g) => (g.risk_severity || "LOW") === name).reduce((a, g) => a + g.count, 0),
    }));
  }
  return r;
};

const render = (r = report()) => tooltip(r, false, Date.parse("2026-09-21T11:00:00Z")).value;

// The hover is CLIPPED, not shrunk, past ~484px, so a column set that sums
// over TABLE_W silently loses the rightmost column off the edge.
test("every table fits the hover and its columns sum exactly", () => {
  // 484 is the real budget: hoverWidget.css caps contents at 500px with
  // 8px padding each side, and a wider table is CLIPPED, not shrunk.
  const USABLE = 484;
  const html = render();
  const tables = [...html.matchAll(/<table width="(\d+)">((?:<col width="\d+">)+)/g)];
  assert.strictEqual(tables.length, 2, `expected both tables, got ${tables.length}`);
  for (const [, width, cols] of tables) {
    const sum = [...cols.matchAll(/<col width="(\d+)">/g)].reduce((a, m) => a + +m[1], 0);
    // Asserted against the LITERAL budget, not against the declared width:
    // COL_W derives from TABLE_W, so comparing the two can only ever agree.
    assert.ok(+width <= USABLE, `table declares ${width}, clipped past ${USABLE}`);
    assert.strictEqual(sum, +width, `columns sum to ${sum}, table declares ${width}`);
  }
});

// The severity strip is the table that names CRITICAL. Found by content: the
// header line is a table of its own since 2026-10-01, so it is not the first.
const stripOf = (html) => html.split("<table").find((t) => t.includes("CRITICAL"));

// The strip is four severities, no FINDINGS subtotal and no divider, and the
// rows sit under a TOP FINDINGS line whose icon reflects what is under it
// (2026-09-25). The divider existed only to separate LOW from the subtotal.
test("the strip is four severities with no divider, under a TOP FINDINGS line", () => {
  const html = render();
  assert.ok(!html.includes("\u2502"), "a divider bar is still drawn");
  const strip = stripOf(html);
  assert.ok(!/FINDINGS/.test(strip.split("</table>")[0]), "the strip still has a FINDINGS column");
  assert.strictEqual((strip.match(/<col width=/g) || []).length, 4, "expected four equal severity columns");
  assert.match(html, /\$\(info\)[^\n]*\*\*TOP FINDINGS\*\*/, "LOW-only window should show the info mark");
  const found = render(report({ grouped_file_changes_risk: [group({ risk_severity: "HIGH", risk_category: "SECRET_FILE" })] }));
  assert.match(found, /\$\(warning\)[^\n]*\*\*TOP FINDINGS\*\*/, "a finding should show the warning mark");
});

// Left/right anchoring was removed; anything else is a regression.
test("the severity row is centered throughout", () => {
  const row = stripOf(render());
  assert.ok(!/align="(left|right)"/.test(row), "found an edge-anchored severity cell");
});

// Break hints are a RENDERING concern. They must never reach file_pattern
// itself, which is documented as a glob a reader can paste.
test("comma break hints are added to the pattern and nowhere else", () => {
  const html = render();
  assert.ok(html.includes(",​"), "no zero-width space after a pattern comma");
  const r = report();
  assert.ok(!r.grouped_file_changes_risk[0].file_pattern.includes("​"), "hint leaked into the data");
});

// md() escapes "*" to "\*", which renders as a literal backslash inside a
// <td>. Cells go through esc(), so a pattern full of stars must survive.
test("a starred pattern is not markdown-escaped", () => {
  const html = render(report({ grouped_file_changes_risk: [group({ file_pattern: "*.{go,*}" })] }));
  assert.ok(!html.includes("\\*"), "pattern was markdown-escaped inside the table");
  assert.ok(html.includes("*.{go,"), "pattern missing from the row");
});

// grouped_file_changes_risk is OMITTED, not empty, on an idle window. Reading it
// unguarded threw on undefined.filter and blanked the hover.
test("an idle window with no anomalies key still renders", () => {
  const r = report();
  delete r.grouped_file_changes_risk;
  r.grouped_file_changes_risk_total = 0;
  assert.doesNotThrow(() => render(r));
});

// The cap bounds the hover's height; without it a busy day rendered
// every group.
test("no more than MAX_ROWS detail rows are rendered", () => {
  const many = Array.from({ length: 40 }, (_, i) => group({ common_path: `/p${i}/` }));
  const html = render(report({ grouped_file_changes_risk: many, grouped_file_changes_risk_total: 40 }));
  const rows = (html.match(/<tr valign="top">/g) || []).length;
  assert.ok(rows > 0, "counted no detail rows at all — the row markup moved");
  // Asserted as a BOUND, not as the current cap: this pins that truncation
  // happens and stays glanceable, so retuning MAX_ROWS does not rewrite the
  // test. An earlier version hardcoded 10 and broke the moment it moved.
  assert.ok(rows < 40, `rendered ${rows} of 40 groups — nothing was truncated`);
  assert.ok(rows <= 20, `rendered ${rows} rows, too many for a glance`);
});
