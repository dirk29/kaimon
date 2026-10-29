// The two webviews.
//
// Level 1 (activity) is generated here from the report JSON. Level 3 (the full
// report) is the CLI's own HTML, dropped in unmodified — it is already
// self-contained, with fonts inlined as data: URIs and no remote fetches, so it
// needs a CSP nonce for its one inline script and nothing else.
//
// Level 1 repeats the hover's rows line for line and opens each one onto the
// real files behind its pattern. See row.ts for why the line is shared.

import * as vscode from "vscode";
import * as browser from "./browser";
import * as cli from "./cli";
import * as row from "./row";
import * as timeline from "./timeline";

function nonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < 32; i++) {
    s += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return s;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function num(n: number): string {
  return n.toLocaleString();
}


// What the page needs from the extension that it cannot compute itself.
export interface Assets {
  // Webview URI of the same woff the hover's codicons come from, so both
  // surfaces draw the marks from one file.
  font: string;
  // webview.cspSource, which font-src must allow for that URI to load.
  csp: string;
  // Icon id -> its character in that font, read from package.json so the
  // codepoints have one source.
  glyphs: Record<string, string>;
}

// What survives a refresh. The page is rebuilt by replacing its HTML on every
// poll, which reloads it: without this, a row the user opened snapped shut and
// the list jumped to the top every thirty seconds.
export interface ViewState {
  open: Set<string>;
  scrollY: number;
  // The find text, kept so a rebuild on the next poll re-applies it.
  query: string;
}

// The header, 1:1 with the hover's: title, who did what, then the findings
// count and the four severity counts. Drawn from row.summary, the same data
// the hover draws from, so the two cannot say different things.
function headerHTML(sm: row.Summary, a: Assets, sel: string): string {
  const eye = a.glyphs["kaimon-eye"] ? `<span class="mark">${a.glyphs["kaimon-eye"]}</span>` : "";
  const bits: string[] = [];
  if (!sm.collecting) {
    bits.push("<b>Not collecting</b>");
  }
  if (sm.agents.length) {
    const names = sm.agents.map((n) => {
      const id = cli.actorIcon(n) ?? cli.GENERIC_ACTOR_ICON;
      const mark = a.glyphs[id] ? `<span class="mark a-${id}" title="${esc(row.agentProduct(n))}">${a.glyphs[id]}</span>` : "";
      return `${mark}<b>${esc(row.agentLabel(n))}</b>`;
    });
    // No "Agents" prefix: each name carries its mark and is bold, which already
    // says what it is. Same as the hover.
    bits.push(row.changesBy(names.join(", "), sm.logs, sm.flagged, true));
  } else {
    bits.push("No activity attributed to any agent");
  }
  // The one control on the page: which window the panel shows. The status bar
  // and hover stay on the kaimon.window setting — a glance is about now — and
  // the panel opens on the same window, so it starts 1:1 with the hover.
  const choices = cli.WINDOWS.some((w) => w.since === sel) ? cli.WINDOWS
    : [...cli.WINDOWS, { label: cli.windowLabel(sel), since: sel }];
  const picker = `<label class="win">Last <select id="win">${choices
    .map((w) => `<option value="${esc(w.since)}"${w.since === sel ? " selected" : ""}>${esc(w.label)}</option>`)
    .join("")}</select></label>`;
  // It leads the second line, "Last [1h ▾] Agents … made N changes to M
  // files", so the window reads as part of the sentence it scopes: every number
  // on the page — changes, files, the severity strip, the rows, the footer —
  // comes from that one window's report.
  return `<div class="title">${eye}<b>kaimon — Agent Integrity Monitor (AIM)</b></div>
  <p class="sub">${picker} ${bits.join(" · ")}</p>`;
}

// Find, in the page. VS Code's own Find (enableFindWidget) was tried first on
// 2026-09-25 and neither highlighted nor opened collapsed rows in Antigravity —
// its webview find is either window.find() or a native find this page did not
// get — and opening the rows whose files match is the whole point. So the page
// does it: highlight every match in the rows, open each row whose FILES match,
// never hide a row. It is find-in-page, not a filter; the window picker stays
// the only selector in the free version. Inline SVG for the magnifier because a
// webview cannot use the workbench's icon font.
function findHTML(q: string): string {
  const icon = (d: string) => `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
  const glass = icon(`<circle cx="6.5" cy="6.5" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/>` +
    `<path d="M10 10l4.2 4.2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>`);
  const cross = icon(`<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`);
  // The dashboard's search, in VS Code's colors: a magnifier that expands into
  // a field, with a clear button once there is text, and the match count to
  // its left where the dashboard says "Found N of M".
  return `<div class="search${q ? " open has" : ""}">
    <span id="qn" class="qn"></span>
    <div class="sfield">
      <button id="findbtn" class="icon sicon" title="Find (Ctrl+F / \u2318F)" aria-label="Find">${glass}</button>
      <input id="q" type="text" placeholder="Find\u2026" value="${esc(q)}" spellcheck="false" aria-label="Find in rows">
      <button id="qclear" class="icon sclear" title="Clear" aria-label="Clear">${cross}</button>
    </div>
  </div>`;
}

// The bar above the table, after the dashboard's "TOP ANOMALIES" card header,
// drawn as a VS Code section header so it reads as native. No count: the
// severity strip above already carries them. The report opens from the
// "Open Report" button below the footer (a "›" here was easy to miss).
// "Open Report" from 2026-09-29, when "full" seemed to promise all 99 rows
// under "Top 20 of 99"; back to "Full" 2026-09-30 (Dirk): the report is the
// full picture — tiles, timeline, every section — not just the rows.
//
// The icon says what is under it: a warning, colored like the worst severity
// present, when there are findings; an info mark in LOW's color when there is
// only LOW; a plain info mark on an empty window. Same rule as the hover.
function barHTML(q: string, sm: row.Summary): string {
  const svg = (d: string) => `<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">${d}</svg>`;
  const warn = svg(`<path d="M8 1.8l6.6 11.7H1.4z" fill="none" stroke="currentColor" stroke-width="1.4" ` +
    `stroke-linejoin="round"/><path d="M8 6.3v3.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
    `<circle cx="8" cy="11.6" r=".9" fill="currentColor"/>`);
  const info = svg(`<circle cx="8" cy="8" r="6.3" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
    `<path d="M8 7.2v4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>` +
    `<circle cx="8" cy="4.9" r=".9" fill="currentColor"/>`);
  const finding = sm.worst && sm.worst.k !== "LOW";
  const tint = sm.worst ? ` class="s-${sm.worst.k.toLowerCase()}"` : "";
  return `<div class="bar"><span class="bt"><span${tint}>${finding ? warn : info}</span>Top findings</span>` +
    `${findHTML(q)}</div>`;
}

// CRITICAL, HIGH, MEDIUM, LOW — the hover's strip, in logs like the dashboard's
// severity boxes. A zero keeps its place in the faded shade.
function tiersHTML(sm: row.Summary): string {
  // One line, after the dashboard's severity boxes: label left, count badge
  // right, tinted in the severity's color, faded at zero. Two lines (labels
  // over values) spent a whole extra row on four numbers.
  return `<div class="tiers">${sm.tiers.map((t) =>
    `<div class="tier ${t.dim ? "d" : "s"}-${t.k.toLowerCase()}${t.n === 0 ? " zero" : " live"}" data-sev="${t.k}">` +
    `<span class="tl">${t.k}</span><span class="tv">${num(t.n)}</span></div>`).join("")}</div>`;
}

// The dashboard's TIMELINE card, between the severity boxes and the table as
// there. Absent when the CLI predates clock-aligned slots.
function timelineHTML(r: cli.Report, sel: string): string {
  const chart = timeline.svg(r);
  if (!chart) {
    return "";
  }
  const clock = `<svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true">` +
    `<circle cx="8" cy="9" r="5.8" fill="none" stroke="currentColor" stroke-width="1.4"/>` +
    `<path d="M8 6v3.2l2 1.3M6.3 1.6h3.4" fill="none" stroke="currentColor" stroke-width="1.4" ` +
    `stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  return `<div class="tline"><div class="tline-h">${clock}Timeline (${timeline.span(sel)})</div>${chart}</div>`;
}

// What happened to one file, in the report's own notation and order — CR,
// ATT, MOD, WR, MV, DEL, kinds present rather than counts (apps/cli/internal/
// render, events) — so a reader who has seen "CR,MOD" in the report reads the
// panel without learning anything new.
const EVENT_CODES: [keyof cli.FileEvents, string][] = [
  ["create", "CR"], ["attrib", "ATT"], ["modify", "MOD"],
  ["write", "WR"], ["move", "MV"], ["delete", "DEL"],
];

function titled(t: string): string {
  return t ? ` title="${esc(t)}"` : "";
}

function eventCodes(e?: cli.FileEvents): string {
  return e ? EVENT_CODES.filter(([k]) => e[k] > 0).map(([, c]) => c).join(",") : "";
}

// The file's net size change after its events, signed like a diff stat and
// in the events' own muted gray — red and green competed with the severity
// colors, and the sign already says which way: "MOD,WR +159", "DEL -6.04M",
// "+1.71K", "+45.6K", "±0". A space is the only separator: commas join the
// events and the sign starts the number. A colon and a middle dot were tried;
// the dot read as a makeshift column, the colon as one mark too many. Bytes,
// decimal K/M/G from 1,000 up at three significant digits; the unit and the
// exact value live in the cell's tooltip (eventsTitle). Nothing when the CLI
// measured none, which is not the same as no change.
function sizeChange(n?: number): string {
  if (n === undefined) {
    return "";
  }
  const sign = n > 0 ? "+" : n < 0 ? "-" : "±";
  return ` <span class="sz">${sign}${compact(Math.abs(n))}</span>`;
}

// The FIM portal documentation's names for the event codes (DashboardLegend.tsx),
// in the codes' order; the report uses the same (render.eventNames).
const EVENT_NAMES: [keyof cli.FileEvents, string][] = [
  ["create", "CREATE"], ["attrib", "ATTRIB"], ["modify", "MODIFY"],
  ["write", "WRITE"], ["move", "MOVE"], ["delete", "DELETE"],
];

// The tooltip over a file's events and size together, as in the report:
// "Detected MODIFY and WRITE events with a net file size change of +1,234
// bytes". The cell shows the size rounded; this gives it exactly.
function eventsTitle(e?: cli.FileEvents, n?: number): string {
  const names = e ? EVENT_NAMES.filter(([k]) => e[k] > 0).map(([, name]) => name) : [];
  if (names.length === 0) {
    return "";
  }
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  let t = `Detected ${list} events`;
  if (n !== undefined) {
    const sign = n > 0 ? "+" : n < 0 ? "-" : "±";
    t += ` with a net file size change of ${sign}${num(Math.abs(n))} bytes`;
  }
  return t;
}

function compact(a: number): string {
  if (a < 1_000) {
    return num(a);
  }
  const [div, unit] = a < 1e6 ? [1e3, "K"] : a < 1e9 ? [1e6, "M"] : [1e9, "G"];
  const v = a / div;
  // Three significant digits; rounding up can carry into the next unit
  // (999,950 -> "1000K"), so that case is printed in the next one.
  const s = v.toPrecision(3);
  return Number(s) >= 1000 && unit !== "G" ? compact(Number(s) * div) : `${Number(s)}${unit}`;
}

function agentCell(x: row.Row, a: Assets): string {
  let lead = "";
  if (x.unattributed) {
    lead = `<span class="s-low">—</span>`;
  } else if (x.mark && a.glyphs[x.mark]) {
    lead = `<span class="mark a-${x.mark}" title="${esc(row.agentProduct(x.agent))}">${a.glyphs[x.mark]}</span>`;
  }
  const tail = x.pattern ? `<i>${esc(x.pattern).replace(/,/g, ",<wbr>")}</i>` : "";
  return [...(lead ? [lead] : []), ...x.chain.map(esc), ...(tail ? [tail] : [])].join(" › ");
}

// Every row the hover has, in the hover's order, drawn as the hover draws it —
// so the line a user noticed there is the line they find here. The hover stops
// at ten; this does not, because it is where the rest of the list lives.
//
// Opened, a row shows what the hover cannot: the real files behind the
// pattern, full paths, most active first. The hover summarizes, the report
// exhausts, and this bridges them — the same line, then one level deeper.
// The panel shows the top PANEL_ROWS, the page the report and its JSON show
// (the CLI's -top 20) and the cloud's printed report too; the cloud's depth —
// up to 1,000 anomalies — is the upgrade (2026-09-28). It still FETCHES up to
// 100 groups, as the hover does: the header's totals are summed over what
// arrives, so fetching only 20 would undercount them.
export const PANEL_ROWS = 20;

function rowsHTML(r: cli.Report, a: Assets, open: Set<string>): string {
  const rows = row.ranked(cli.groups(r)).slice(0, PANEL_ROWS).map((g) => row.toRow(g, undefined, r.meta.end_time));
  if (rows.length === 0) {
    return `<p class="foot">No risk findings recorded in this window.</p>`;
  }
  const items = rows
    .map((x) => {
      // Every cell prints exactly what the hover prints — the count included,
      // raw, because the hover's narrow # column prints it raw.
      const cells = `<span class="risk s-${x.severity.toLowerCase()}"${x.description ? ` title="${esc(x.description)}"` : ""}>${esc(x.category)}</span>
        <span class="what">${agentCell(x, a)}</span>
        <span class="n">${x.logs}</span>
        <span class="when">${row.dayOffsetHTML(esc(x.seen))}</span>`;
      // The timeline slots this row, and each file below, had changes in: the
      // page script lights and opens exactly these for the slot under the mouse.
      const slots = (s?: number[]) => ` data-slots="${(s ?? []).join(",")}"`;
      const top = x.group.top_files ?? [];
      // No disclosure when there is nothing behind it. An empty expansion is
      // worse than none: it reads as missing data.
      if (top.length === 0) {
        return `<li${slots(x.group.slots)} data-sev="${x.severity}"><div class="grid">${cells}</div></li>`;
      }
      // Each file's count is in log records, the "#" column's unit, so it sits
      // IN that column, under the total it sums to when every file is shown.
      // Its own seen span sits under the row's, which is the union of them.
      // What happened to it sits in the Risk column, left-aligned under the
      // category like every other text in the table — right-aligned was tried
      // and left a ragged edge floating mid-column.
      // Whatever the list falls short by is in files past the cap.
      const rest = x.logs - top.reduce((n, f) => n + f.count, 0);
      // group.files is the distinct paths in the whole group, not just the list.
      const others = Math.max(x.group.files - top.length, 1);
      const files = top
        // The full path. It was shortened to "~/..." on the viewer's $HOME,
        // which is the wrong home whenever the agent wrote as another user.
        .map((f) => `<li class="grid"${slots(f.slots)}><span class="ev"${titled(eventsTitle(f.file_events, f.file_size_change))}>${eventCodes(f.file_events)}${sizeChange(f.file_size_change)}</span>` +
          `<code>${esc(f.name)}</code>` +
          `<span class="n" title="${num(f.count)} file change${f.count === 1 ? "" : "s"}">${f.count}</span>` +
          `<span class="when">${row.dayOffsetHTML(esc(row.clock(f.first_seen, f.last_seen, r.meta.end_time)))}</span></li>`)
        .join("");
      const more = rest > 0
        ? `<li class="grid"><span class="more">and ${num(rest)} more finding${rest === 1 ? "" : "s"} in ${num(others)} other file${others === 1 ? "" : "s"}</span></li>`
        : "";
      const k = row.key(x.group);
      return `<li${slots(x.group.slots)} data-sev="${x.severity}"><details data-k="${esc(k)}"${open.has(k) ? " open" : ""}>` +
        `<summary class="grid">${cells}</summary><ol class="files">${files}${more}</ol></details></li>`;
    })
    .join("");
  return `<div class="grid head"><span>Risk</span><span class="what">Agent › Tools › <i>Files</i></span>` +
    `<span class="n">#</span><span class="when">Seen</span></div><ul class="rows">${items}</ul>`;
}

// Severity and actor colors are generated from the SAME constants the hover
// uses, as classes: this page's CSP is nonce-only for styles, and a nonce
// covers <style> elements but never style="" attributes (see showReport), so
// the hover's inline colors would be silently dropped here.
function palette(): string {
  const sev = Object.entries(cli.SEVERITY_COLOR)
    .map(([s, hex]) => `.s-${s.toLowerCase()} { color: ${hex}; }`);
  const dim = Object.entries(cli.SEVERITY_DIM)
    .map(([k, hex]) => `.d-${k.toLowerCase()} { color: ${hex}; }`);
  const act = Object.entries(cli.ACTOR_COLOR)
    .map(([id, hex]) => `.a-${id} { color: ${hex}; }`);
  return [...sev, ...dim, ...act].join("\n    ");
}

function styles(a?: Assets): string {
  return `
    ${a ? `@font-face { font-family: kaimon-actors; src: url("${a.font}") format("woff"); }` : ""}
    body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size);
           color: var(--vscode-foreground); padding: 20px 24px 28px; max-width: 900px;
           line-height: 1.5; }

    /* The header, 1:1 with the hover: title, who did what, the severity
       strip, then the rows, then the footer line. */
    /* One fixed box per mark, glyph centered: each vendor mark has its own
       width, and the "›" after it should line up row to row. */
    .mark { font-family: kaimon-actors; font-style: normal; margin-right: 3px;
      display: inline-block; width: 1.15em; text-align: center; }
    .title { font-size: 1.05em; margin: 0 0 8px; }
    .title { display: flex; align-items: center; }
    .title .mark { margin-right: 7px; }
    /* Before the search rules on purpose: they override its display, and
       declaration order then agrees with specificity. */
    .icon { display: flex; padding: 3px; border: none; border-radius: 4px; cursor: pointer;
            background: none; color: var(--vscode-icon-foreground, var(--vscode-descriptionForeground)); }
    .icon:hover { background: var(--vscode-toolbar-hoverBackground); color: var(--vscode-foreground); }
    .bar { display: flex; align-items: center; justify-content: space-between; gap: 8px;
           margin-top: 16px; padding: 3px 6px 3px var(--gutter); min-height: 30px;
           background: var(--vscode-sideBarSectionHeader-background, rgba(128, 128, 128, .12));
           color: var(--vscode-sideBarSectionHeader-foreground, var(--vscode-foreground));
           border-top: 1px solid var(--vscode-sideBarSectionHeader-border, transparent);
           font-size: .85em; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; }
    .bt { display: flex; align-items: center; gap: 7px; }
    /* The timeline card, after the dashboard's: a bordered card with a small
       gray heading. */
    .tline { margin-top: 16px; padding: 10px 12px 2px; border-radius: 6px;
             border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, .35)); }
    .tline-h { display: flex; align-items: center; gap: 6px; font-size: .8em; font-weight: 600;
               letter-spacing: .1em; text-transform: uppercase; color: var(--vscode-descriptionForeground); }
    .tl-chart { display: block; width: 100%; height: auto; }
    .tl-grid { stroke: var(--vscode-panel-border, rgba(128, 128, 128, .35)); stroke-width: 1; stroke-dasharray: 2; }
    .tl-tick { stroke: var(--vscode-descriptionForeground); stroke-width: 1; opacity: .5; }
    .tl-axis, .tl-legend { fill: var(--vscode-descriptionForeground); font-size: 9px; }
    .tl-legend { font-weight: 500; }
    /* File changes in kaimon's primary brand blue (--blue on the website).
       The theme's chart blue sat at LOW's lightness and read as the same
       line; the dashboard's #2B6493 was too dark on a dark panel. This one
       differs from LOW's slate in both saturation and lightness (Dirk,
       2026-09-25). The risk line's color comes per slot from the severity
       palette, as a stroke attribute. */
    .tline { --tl-blue: #2563eb; }
    .tl-logs { fill: none; stroke: var(--tl-blue); stroke-width: 1.5; }
    .tl-flag { fill: none; stroke-width: 1.6; stroke-linecap: round; }
    .tl-flag.tl-none { stroke: var(--vscode-descriptionForeground); }
    .tl-hit { fill: transparent; cursor: pointer; }
    /* A row's slots, shaded while the mouse is on the row. */
    /* The text color at low opacity: a lighter gray on a dark theme, a darker
       one on a light theme. The rows' own hover gray vanished inside the chart,
       worst for a day's ~8px slot under a spike; side edges were tried and
       dropped (2026-09-26). */
    .tl-band { fill: var(--vscode-foreground); fill-opacity: .12; pointer-events: none; }
    /* Switching window: a run over a day takes seconds, so the page says it is
       loading and dims what is still the OLD window's data, which must not be
       read as the new one. Everything is replaced when the report arrives. */
    .busy { position: fixed; top: 0; left: 0; right: 0; height: 2px; overflow: hidden; display: none; }
    .busy::before { content: ""; position: absolute; top: 0; bottom: 0; width: 30%;
                    background: var(--vscode-progressBar-background, #0e70c0); animation: busy 1.2s ease-in-out infinite; }
    @keyframes busy { from { left: -30%; } to { left: 100%; } }
    body.loading .busy { display: block; }
    body.loading > :not(.title):not(.sub):not(.busy):not(script) { opacity: .45; pointer-events: none; transition: opacity .15s; }
    /* The dashboard's axis pointer and popup. Positioned by the page script
       through CSSOM, which the CSP allows where it forbids style attributes. */
    .tline { position: relative; }
    .tl-guide { stroke: var(--vscode-descriptionForeground); stroke-width: 1; stroke-dasharray: 3 2; pointer-events: none; }
    .tl-mk { stroke: var(--vscode-editor-background); stroke-width: 1.5; pointer-events: none; }
    .tl-mk-logs { fill: var(--tl-blue); }
    .tl-tip { position: absolute; z-index: 5; pointer-events: none; padding: 4px 9px;
              border-radius: 4px; font-size: 11px; line-height: 1.45;
              color: var(--vscode-editorHoverWidget-foreground, var(--vscode-foreground));
              background: var(--vscode-editorHoverWidget-background);
              border: 1px solid var(--vscode-editorHoverWidget-border, rgba(128, 128, 128, .35));
              box-shadow: 0 2px 8px var(--vscode-widget-shadow, rgba(0, 0, 0, .36)); }
    .tl-tip[hidden] { display: none; }
    .tt-h { color: var(--vscode-descriptionForeground); }
    .tt-r { display: flex; align-items: center; gap: 8px; }
    /* Label and number side by side with a fixed gap, numbers aligned right
       across the rows. A min-width stretched the label and pushed the number
       far off (2026-09-25). */
    .tt-k { flex: 1; }
    .tt-r b { margin-left: 12px; }
    .tt-d { width: 7px; height: 7px; border-radius: 50%; background: var(--vscode-descriptionForeground); }
    .tt-logs { background: var(--tl-blue); }
    .tt-s { padding-left: 16px; font-size: .9em; color: var(--vscode-descriptionForeground); }
    .tt-s:empty { display: none; }
    .bt > span { display: flex; }
    .search { display: flex; align-items: center; gap: 8px;
              text-transform: none; letter-spacing: 0; font-weight: 400; }
    .qn { color: var(--vscode-descriptionForeground); white-space: nowrap; }
    .sfield { position: relative; width: 26px; height: 24px; transition: width .2s ease; }
    .search.open .sfield { width: 220px; }
    .sicon { position: absolute; left: 1px; top: 50%; transform: translateY(-50%); z-index: 1; }
    /* Hidden with a selector that outranks .icon's display:flex, which is
       declared later. Equal specificity let the clear button show over the
       magnifier while the field was closed, so the click cleared instead of
       opening (2026-09-25). */
    .search .sfield .sclear { position: absolute; right: 1px; top: 50%; transform: translateY(-50%);
                              z-index: 1; display: none; }
    .search.open.has .sfield .sclear { display: flex; }
    .sfield input { width: 100%; height: 100%; box-sizing: border-box; padding: 0 24px 0 26px; font: inherit;
                    outline: none; border-radius: 3px; opacity: 0; pointer-events: none;
                    color: var(--vscode-input-foreground); background: var(--vscode-input-background);
                    border: 1px solid var(--vscode-input-border, transparent); }
    .search.open .sfield input { opacity: 1; pointer-events: auto; }
    .sfield input:focus { border-color: var(--vscode-focusBorder); }
    mark.hit { background: var(--vscode-editor-findMatchHighlightBackground); color: inherit; border-radius: 2px; }
    mark.cur { background: var(--vscode-editor-findMatchBackground);
               outline: 1px solid var(--vscode-editor-findMatchBorder, transparent); }
    .win select { margin-left: 4px; font-family: inherit; font-size: inherit; font-weight: 600; padding: 0 2px;
                  color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background);
                  border: 1px solid var(--vscode-dropdown-border); border-radius: 2px; }
    .sub { margin: 0; }
    .sub b { font-weight: 600; }
    .sub .mark { margin-right: 4px; }
    /* Symmetric with the 4px before the select: the text space alone read as
       too tight against the dropdown's box. */
    .win { margin-right: 4px; }
    hr { border: none; border-top: 1px solid var(--vscode-panel-border); margin: 10px 0; }
    .tiers { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; }
    /* Tinted from the text color, so each box follows its own severity and the
       theme's background: a filled box in fixed hexes would fight a light theme. */
    .tier { display: flex; justify-content: space-between; align-items: center; gap: 8px;
            padding: 5px 8px 5px 12px; border-radius: 4px; font-weight: 700; letter-spacing: .03em;
            background: color-mix(in srgb, currentColor 16%, transparent); }
    .tier.zero { background: color-mix(in srgb, currentColor 7%, transparent); }
    .tier .tv { min-width: 1.4em; padding: 0 6px; border-radius: 3px; text-align: center;
                background: color-mix(in srgb, currentColor 20%, transparent); }
    .tier.zero .tv { background: none; }
    .foot { color: var(--vscode-descriptionForeground); font-style: italic; margin: 10px 0 0; }
    /* The one way to the CLI's full HTML report: an afterthought, gray, below
       the footer on the left. Tried the same day (2026-09-26): a "\u203a" beside
       TOP FINDINGS (missed), gray on the footer line (missed), blue on that line
       (glued to the table, all but demanding a click), blue below the footer on
       the right (still in the face). */
    .more-report { margin-top: 20px; }
    .btn { padding: 4px 12px; border-radius: 2px; cursor: pointer; font: inherit;
           color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground);
           border: 1px solid var(--vscode-button-border, transparent); white-space: nowrap; }
    .btn:hover { background: var(--vscode-button-secondaryHoverBackground); }

    /* The rows. The hover's four columns — Risk, Agent > Tools > Files, #,
       Seen — under the hover's own headers. Fixed widths so the columns
       line up across rows, each of which is its own <details>. Risk fits the
       longest category in the ruleset, CREDENTIAL ACCESS / DEPENDENCY CHANGE. */
    :root { --risk: 12em; --num: 3.5em; --when: 7.5em; --gap: 14px; --gutter: 16px; }
    ul { list-style: none; padding: 0; margin: 0; }
    /* Seen grows past --when when a range needs both am and pm
       ("4:57pm → 9:01am"): the page script measures the widest one into
       --when-fit, since each row is its own grid and cannot size a column
       for the others. */
    .grid { display: grid; grid-template-columns: var(--risk) 1fr var(--num) max(var(--when), var(--when-fit, 0px));
            column-gap: var(--gap); align-items: baseline; padding: 4px 0 4px var(--gutter); }
    .head { font-weight: 600; padding-top: 0; padding-bottom: 6px;
            border-bottom: 1px solid var(--vscode-panel-border); }
    .rows > li + li { border-top: 1px solid var(--vscode-panel-border); }
    .risk { font-weight: 700; white-space: nowrap; }
    .what i { font-style: italic; }
    /* VS Code gives <code> a filled, padded box in webviews. Paths here are
       data in a list, not inline snippets in prose, so the box is noise. */
    code { font-family: var(--vscode-editor-font-family); background: none; padding: 0; border-radius: 0; }
    .n, .when { text-align: right; white-space: nowrap; }
    .dayoff { font-size: .7em; color: var(--vscode-descriptionForeground); margin-left: 1px; }

    /* The disclosure lives in the gutter, so the four columns start at the
       same x on every row whether or not it opens. */
    .rows details { position: relative; }
    .rows summary { cursor: pointer; list-style: none; }
    .rows summary::-webkit-details-marker { display: none; }
    .rows details::before { content: "›"; position: absolute; left: 3px; top: 4px;
            color: var(--vscode-descriptionForeground); pointer-events: none; }
    .rows details[open]::before { content: "⌄"; left: 1px; top: 0; }
    .rows summary:hover { background: var(--vscode-list-hoverBackground); }
    /* Lit from the timeline: the rows with changes in the slot under the
       mouse, and after a click the files that made them. */
    .rows > li.tl-on > .grid, .rows > li.tl-on > details > summary,
    .rows > li.sev-on > .grid, .rows > li.sev-on > details > summary { background: var(--vscode-list-hoverBackground); }
    /* A severity box with rows behind it works like the timeline: point to
       light that severity's rows, click to open them, click again to close. */
    .tier.live { cursor: pointer; }
    .files > li.tl-pick { background: var(--vscode-list-inactiveSelectionBackground, rgba(128, 128, 128, .18)); }

    /* The expansion: what the pattern stood for. Each file is a row on the
       SAME grid as the finding it expands — the path in the Files column,
       under the pattern it matched, and its count in the # column, under the
       total it sums to. Smaller and quieter than the row above it. */
    .files { margin: -2px 0 8px; padding: 0; list-style: none; }
    .files .grid { padding-top: 1px; padding-bottom: 1px; }
    .files code { grid-column: 2; font-size: .85em; line-height: 1.45;
                  color: var(--vscode-descriptionForeground); overflow-wrap: anywhere; }
    .files .ev { grid-column: 1; white-space: nowrap;
                 font-family: var(--vscode-editor-font-family); font-size: .8em;
                 color: var(--vscode-descriptionForeground); }
    .files .n { grid-column: 3; }
    .files .when { grid-column: 4; }
    .files .n, .files .when { font-size: .85em; color: var(--vscode-descriptionForeground); }
    .files .more { grid-column: 2 / -1; }
    .files .more { color: var(--vscode-descriptionForeground); font-style: italic; font-size: .9em; }

    /* Severity and actor palette: the hover's own hexes. LOW is blue-gray
       rather than green — green reads as "verified fine", but LOW means
       "recorded". */
    ${palette()}

  `;
}

export function activityBody(r: cli.Report, collecting: boolean, n: string, a: Assets, view: ViewState,
  at = Date.now(), sel = cli.currentWindow()): string {
  const sm = row.summary(r, collecting);
  const shown = Math.min(cli.groups(r).length, PANEL_ROWS);
  const total = r.grouped_file_changes_risk_total ?? shown;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src 'nonce-${n}'; script-src 'nonce-${n}'; font-src ${a.csp};">
<style nonce="${n}">${styles(a)}</style>
</head>
<body>
  <div class="busy" aria-hidden="true"></div>
  ${headerHTML(sm, a, sel)}
  <hr>
  ${tiersHTML(sm)}
  ${timelineHTML(r, sel)}
  ${barHTML(view.query, sm)}
  ${rowsHTML(r, a, view.open)}
  <p class="foot">${row.footerText(shown, total, r.meta.host, at, esc)}</p>
  <div class="more-report"><button id="full" class="btn">Open Report</button></div>
<script nonce="${n}">
  const vscode = acquireVsCodeApi();
  // What a click on the timeline or a severity box last opened ("t12",
  // "sMEDIUM"): one state for both, so a second click on the same thing
  // closes it, and a click on the other opens rather than toggling.
  let pick = '';
  // Seen fits its widest visible range. A Range measures the text itself,
  // not the fixed track it overflows. Files inside a closed row measure 0,
  // so it measures again whenever a row opens.
  const fitSeen = () => {
    const text = document.createRange();
    if (!text.getBoundingClientRect) { return; }
    let w = 0;
    document.querySelectorAll('.rows .when').forEach((el) => {
      text.selectNodeContents(el);
      w = Math.max(w, text.getBoundingClientRect().width);
    });
    if (w) { document.documentElement.style.setProperty('--when-fit', Math.ceil(w) + 'px'); }
  };
  fitSeen();
  document.addEventListener('toggle', fitSeen, true);
  // The timeline's axis pointer: guide, markers and popup follow the slot
  // under the mouse, as on the dashboard.
  (() => {
    const chart = document.querySelector('.tl-chart');
    const tip = document.getElementById('tlTip');
    if (!chart || !tip) { return; }
    const card = chart.parentElement;
    const guide = document.getElementById('tlGuide');
    const mkLogs = document.getElementById('tlMkLogs');
    const mkRisk = document.getElementById('tlMkRisk');
    const $ = (id) => document.getElementById(id);
    const show = (el, on) => el.setAttribute('visibility', on ? 'visible' : 'hidden');
    chart.querySelectorAll('.tl-hit').forEach((hit) => hit.addEventListener('mouseenter', () => {
      const d = hit.dataset;
      guide.setAttribute('x1', d.x); guide.setAttribute('x2', d.x);
      mkLogs.setAttribute('cx', d.x); mkLogs.setAttribute('cy', d.yl);
      mkRisk.setAttribute('cx', d.x); mkRisk.setAttribute('cy', d.yr);
      mkRisk.style.fill = d.c || '';
      [guide, mkLogs, mkRisk].forEach((el) => show(el, true));
      $('ttTime').textContent = d.t;
      $('ttLogs').textContent = d.logs;
      $('ttRisk').textContent = d.risk;
      $('ttDot').style.background = d.c || '';
      $('ttSplit').textContent = d.split;
      tip.hidden = false;
      // Beside the guide, flipped left when it would leave the card, and
      // above the plot: its bottom edge on the top gridline, so it covers the
      // heading and legend and leaves the lines in view. On the x-axis it hid
      // too much of the chart (2026-09-25).
      const box = chart.getBoundingClientRect(), outer = card.getBoundingClientRect();
      const gx = box.left - outer.left + (Number(d.x) / Number(chart.getAttribute('viewBox').split(' ')[2])) * box.width;
      const left = gx + 12 + tip.offsetWidth > outer.width ? gx - 12 - tip.offsetWidth : gx + 12;
      tip.style.left = Math.max(0, left) + 'px';
      const vb = chart.getAttribute('viewBox').split(' ').map(Number);
      const plotTop = box.top - outer.top + (Number(chart.dataset.top) / vb[3]) * box.height;
      tip.style.top = Math.max(0, plotTop - tip.offsetHeight) + 'px';
    }));
    // What made this spike? Hovering a slot lights the rows with changes in
    // it; clicking opens them and marks the files that account for it. Every
    // click first closes ALL open rows, so the table always shows exactly one
    // slot's answer, and a slot without risk findings closes everything — the
    // collapse-all, with no button of its own; clicking the same slot again
    // closes what it opened, a toggle (Dirk, 2026-09-25). Exact,
    // from the CLI's per-row and per-file slots — not from Seen, which would
    // light a row that spans the hour at every slot it wrote nothing in.
    const slotsOf = (el) => new Set((el.dataset.slots || '').split(',').filter(Boolean).map(Number));
    const lit = [...document.querySelectorAll('.rows > li[data-slots]')]
      .map((el) => ({ el, set: slotsOf(el), files: [...el.querySelectorAll('.files > li[data-slots]')]
        .map((f) => ({ el: f, set: slotsOf(f) })) }));
    const light = (i) => lit.forEach((r) => r.el.classList.toggle('tl-on', r.set.has(i)));
    chart.querySelectorAll('.tl-hit').forEach((hit) => {
      hit.addEventListener('mouseenter', () => light(Number(hit.dataset.i)));
      hit.addEventListener('click', () => {
        const i = Number(hit.dataset.i);
        let first = null;
        for (const d of document.querySelectorAll('.rows details[open]')) { d.open = false; }
        if (pick === 't' + i) {
          pick = '';
          for (const f of document.querySelectorAll('.tl-pick')) { f.classList.remove('tl-pick'); }
          return;
        }
        pick = 't' + i;
        for (const r of lit) {
          const on = r.set.has(i);
          for (const f of r.files) { f.el.classList.toggle('tl-pick', on && f.set.has(i)); }
          const d = r.el.querySelector('details');
          if (on && d) { d.open = true; }
          if (on && !first) { first = r.el; }
        }
        if (first) { first.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }
      });
    });
    chart.addEventListener('mouseleave', () => {
      tip.hidden = true;
      [guide, mkLogs, mkRisk].forEach((el) => show(el, false));
      lit.forEach((r) => r.el.classList.remove('tl-on'));
    });
    // The reverse: WHEN did this row happen? The mouse on a row, or on one
    // file in it, shades exactly its slots in the chart — contiguous slots as
    // one band, from the slot strips' own geometry.
    const bands = document.getElementById('tlBands');
    const strip = new Map([...chart.querySelectorAll('.tl-hit')].map((h) => [Number(h.dataset.i),
      { x: Number(h.getAttribute('x')), w: Number(h.getAttribute('width')), y: h.getAttribute('y'), h: h.getAttribute('height') }]));
    const shade = (set) => {
      bands.replaceChildren();
      const idx = [...set].sort((a, b) => a - b);
      for (let k = 0; k < idx.length; k++) {
        let j = k;
        while (j + 1 < idx.length && idx[j + 1] === idx[j] + 1) { j++; }
        const a = strip.get(idx[k]), b = strip.get(idx[j]);
        if (a && b) {
          const r = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
          r.setAttribute('class', 'tl-band');
          r.setAttribute('x', a.x); r.setAttribute('width', b.x + b.w - a.x);
          r.setAttribute('y', a.y); r.setAttribute('height', a.h);
          bands.appendChild(r);
        }
        k = j;
      }
    };
    for (const r of lit) {
      r.el.addEventListener('mouseover', (e) => {
        const f = r.files.find((x) => x.el.contains(e.target));
        shade(f ? f.set : r.set);
      });
      r.el.addEventListener('mouseleave', () => bands.replaceChildren());
    }
  })();
  // The severity boxes, the timeline's way (2026-09-29): point to light the
  // rows of that severity; click to close whatever is open, open that
  // severity's rows and scroll to the first — rows sort by severity, so they
  // are one block; click again to close. Not a filter: the window picker stays
  // the only selector, and every row stays on the page.
  (() => {
    const rows = [...document.querySelectorAll('.rows > li[data-sev]')];
    for (const box of document.querySelectorAll('.tier.live')) {
      const k = box.dataset.sev;
      box.addEventListener('mouseenter', () => rows.forEach((r) => r.classList.toggle('sev-on', r.dataset.sev === k)));
      box.addEventListener('mouseleave', () => rows.forEach((r) => r.classList.remove('sev-on')));
      box.addEventListener('click', () => {
        for (const d of document.querySelectorAll('.rows details[open]')) { d.open = false; }
        for (const f of document.querySelectorAll('.tl-pick')) { f.classList.remove('tl-pick'); }
        if (pick === 's' + k) { pick = ''; return; }
        pick = 's' + k;
        const mine = rows.filter((r) => r.dataset.sev === k);
        for (const r of mine) { const d = r.querySelector('details'); if (d) { d.open = true; } }
        if (mine[0]) { mine[0].scrollIntoView({ block: 'start', behavior: 'smooth' }); }
      });
    }
  })();
  document.getElementById('full').addEventListener('click', (e) => {
    e.preventDefault();
    vscode.postMessage({ command: 'showReport' });
  });
  document.getElementById('win').addEventListener('change', (e) => {
    document.body.classList.add('loading');
    vscode.postMessage({ command: 'window', value: e.target.value });
  });
  // Rows that find opened. They are not the user's choice, so they are not
  // reported as open: clearing the find closes them again, and a rebuild
  // re-opens them by re-running the same query.
  const fopened = new Set();
  // Report every open/close so the next rebuild can render it the same way.
  for (const d of document.querySelectorAll('details[data-k]')) {
    d.addEventListener('toggle', () => {
      if (fopened.has(d)) return;
      vscode.postMessage({ command: 'toggle', key: d.dataset.k, open: d.open });
    });
  }
  const search = document.querySelector('.search'), q = document.getElementById('q'), qn = document.getElementById('qn');
  let hits = [], cur = -1;
  function unmark() {
    for (const m of document.querySelectorAll('mark.hit')) {
      const p = m.parentNode;
      p.replaceChild(document.createTextNode(m.textContent), m);
      p.normalize();
    }
  }
  function go(i, jump) {
    if (!hits.length) return;
    if (cur >= 0) hits[cur].classList.remove('cur');
    cur = (i + hits.length) % hits.length;
    hits[cur].classList.add('cur');
    qn.textContent = (cur + 1) + '/' + hits.length;
    if (jump) hits[cur].scrollIntoView({ block: 'center' });
  }
  function run(term, jump) {
    unmark();
    for (const d of fopened) d.open = false;
    fopened.clear();
    hits = []; cur = -1;
    const t = term.trim().toLowerCase();
    const rows = document.querySelector('.rows');
    if (t && rows) {
      const walk = document.createTreeWalker(rows, NodeFilter.SHOW_TEXT);
      const nodes = [];
      while (walk.nextNode()) nodes.push(walk.currentNode);
      for (const node of nodes) {
        const text = node.nodeValue, low = text.toLowerCase();
        let i = low.indexOf(t);
        if (i < 0) continue;
        const frag = document.createDocumentFragment();
        let last = 0;
        while (i >= 0) {
          frag.appendChild(document.createTextNode(text.slice(last, i)));
          const m = document.createElement('mark');
          m.className = 'hit';
          m.textContent = text.slice(i, i + t.length);
          frag.appendChild(m);
          hits.push(m);
          last = i + t.length;
          i = low.indexOf(t, last);
        }
        frag.appendChild(document.createTextNode(text.slice(last)));
        node.parentNode.replaceChild(frag, node);
      }
      for (const m of hits) {
        const d = m.closest('details');
        if (d && !d.open && m.closest('.files')) { fopened.add(d); d.open = true; }
      }
    }
    qn.textContent = t && !hits.length ? 'No results' : '';
    go(0, jump);
  }
  function openFind() { search.classList.add('open'); q.focus(); q.select(); }
  function clearFind() {
    q.value = '';
    search.classList.remove('has');
    run('', false);
    vscode.postMessage({ command: 'query', value: '' });
  }
  function closeFind() { clearFind(); search.classList.remove('open'); }
  document.getElementById('findbtn').addEventListener('click', () =>
    (search.classList.contains('open') ? closeFind() : openFind()));
  document.getElementById('qclear').addEventListener('click', () => { clearFind(); q.focus(); });
  let typing;
  q.addEventListener('input', () => {
    search.classList.toggle('has', q.value !== '');
    clearTimeout(typing);
    typing = setTimeout(() => {
      run(q.value, true);
      vscode.postMessage({ command: 'query', value: q.value });
    }, 120);
  });
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); go(cur + (e.shiftKey ? -1 : 1), true); }
    else if (e.key === 'Escape') { e.preventDefault(); closeFind(); }
  });
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); openFind(); }
  });
  if (q.value) run(q.value, false);
  window.scrollTo(0, ${Math.max(0, Math.round(view.scrollY))});
  vscode.postMessage({ command: 'loaded' });
  let settle;
  window.addEventListener('scroll', () => {
    clearTimeout(settle);
    settle = setTimeout(() => vscode.postMessage({ command: 'scroll', y: window.scrollY }), 150);
  });
</script>
</body>
</html>`;
}

function errorBody(msg: string, n: string, setup?: cli.Setup): string {
  // A setup problem shows its fix as selectable text: the same title, command
  // and note as the hover, which adds a Copy link.
  const body = setup
    ? `<p class="down">${esc(setup.title)}</p>` +
      (setup.command ? `<p>${esc(setup.label ?? "")}: <code>${esc(setup.command)}</code></p>` : "") +
      (setup.note ? `<p>${esc(setup.note)}</p>` : "")
    : `<p class="down">${esc(msg)}</p>`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${n}';">
<style nonce="${n}">${styles()}</style></head>
<body><h1>kaimon</h1>${body}</body></html>`;
}

let activityPanel: vscode.WebviewPanel | undefined;
let extensionUri: vscode.Uri | undefined;
let glyphs: Record<string, string> = {};
const view: ViewState = { open: new Set(), scrollY: 0, query: "" };

// Called once from activate(). The glyph map is read from package.json's
// contributes.icons, which is where the hover's codicons are declared, so the
// two surfaces cannot disagree about which character is which mark.
export function init(ctx: vscode.ExtensionContext): void {
  extensionUri = ctx.extensionUri;
  log = vscode.window.createOutputChannel("kaimon", { log: true });
  ctx.subscriptions.push(log);
  const icons = (ctx.extension.packageJSON?.contributes?.icons ?? {}) as Record<string, { default?: { fontCharacter?: string } }>;
  glyphs = {};
  for (const [id, def] of Object.entries(icons)) {
    const hex = def.default?.fontCharacter?.replace(/^\\/, "");
    if (hex && /^[0-9a-f]+$/i.test(hex)) {
      glyphs[id] = String.fromCodePoint(parseInt(hex, 16));
    }
  }
}

export async function showActivity(): Promise<void> {
  openedAt = Date.now();
  log?.info(`panel: open requested, report ${latest ? ("error" in latest ? "failed" : "cached") : "not yet fetched"}`);
  if (activityPanel) {
    activityPanel.reveal();
  } else {
    activityPanel = vscode.window.createWebviewPanel(
      "kaimon.activity",
      "AIM",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: extensionUri ? [vscode.Uri.joinPath(extensionUri, "assets")] : [],
      },
    );
    activityPanel.onDidDispose(() => {
      pick = undefined;
      own = undefined;
      activityPanel = undefined;
      view.open.clear();
      view.scrollY = 0;
      view.query = "";
    });
    activityPanel.webview.onDidReceiveMessage((m) => {
      if (m?.command === "showReport") {
        void showReport(selected());
      } else if (m?.command === "query" && typeof m.value === "string") {
        view.query = m.value;
      } else if (m?.command === "window" && cli.WINDOWS.some((w) => w.since === m.value)) {
        pick = m.value === cli.currentWindow() ? undefined : m.value;
        own = undefined;
        log?.info(`panel: window ${cli.windowLabel(selected())}`);
        void refreshOwn();
      } else if (m?.command === "toggle" && typeof m.key === "string") {
        if (m.open) {
          view.open.add(m.key);
        } else {
          view.open.delete(m.key);
        }
      } else if (m?.command === "scroll" && typeof m.y === "number") {
        view.scrollY = m.y;
      } else if (m?.command === "loaded" && openedAt) {
        log?.info(`panel: page loaded ${Date.now() - openedAt}ms after the click`);
        openedAt = 0;
      }
    });
  }
  if (latest) {
    draw();
    return;
  }
  // Opened before the first poll has finished — the one case with nothing to
  // show yet. Fetch once rather than leave the panel blank for up to a poll.
  try {
    const [r, collecting] = await Promise.all([cli.report(), cli.daemonActive()]);
    update(r, collecting, Date.now());
  } catch (e) {
    fail((e as Error).message);
  }
}

// The panel never runs the CLI on its own schedule. The status bar's poll
// fetches a report every refreshSeconds and hands it here, so opening the panel
// renders at once from a report at most one poll old — its header shows the
// window's end time, so the age is visible — and an open panel costs no second
// CLI run per poll. Both used to happen: every open waited on a fresh
// `kaimon aim report` (4.4-4.9s over a busy hour, measured 2026-09-23), and
// every poll ran the same report twice, once for the hover and once here.
let latest: { r: cli.Report; collecting: boolean; at: number } | { error: string; setup?: cli.Setup } | undefined;

// Timings for the panel, written by VS Code to the extension's log file
// (Output > kaimon). Opening was measured at 5-6s on 2026-09-23 after the
// report was already cached, so the time is not where it looks; this records
// where it actually goes: the click, the draw, and the page reporting it
// finished loading.
let log: vscode.LogOutputChannel | undefined;
let openedAt = 0;

export function update(r: cli.Report, collecting: boolean, at: number): void {
  latest = { r, collecting, at };
  // A panel on another window than the poll's refreshes its own report on the
  // same beat, so it never shows older data than the status bar does — unless
  // its previous run is still going. Starting over then discarded that run: a
  // one-day scan takes ~8s, and a beat landing mid-run restarted it, so the
  // first load could take a whole extra cycle, and chain under load. A window
  // with its own cadence (WINDOWS every) skips the beats in between.
  if (pick) {
    const every = cli.WINDOWS.find((w) => w.since === pick)?.every;
    const fresh = own !== undefined && every !== undefined && Date.now() - own.at < every * 1000;
    if (ownRunning !== pick && !fresh) {
      void refreshOwn();
    }
  } else {
    draw();
  }
}

// The window the panel is set to, when it differs from the status bar's.
// Undefined means "the same as the status bar", which renders from the poll's
// report at no cost; any other window costs one CLI run per poll while shown
// (measured 2026-09-24: 10m 0.2s, 1d 2.6s on a quiet day).
let pick: string | undefined;
let own: { r: cli.Report; collecting: boolean; at: number } | undefined;
let ownSeq = 0;
let ownRunning: string | undefined; // the window whose run is in flight

function selected(): string {
  return pick ?? cli.currentWindow();
}

async function refreshOwn(): Promise<void> {
  if (!pick) {
    own = undefined;
    draw();
    return;
  }
  const seq = ++ownSeq;
  const w = pick;
  const t = Date.now();
  ownRunning = w;
  try {
    const [r, collecting] = await Promise.all([cli.report(w), cli.daemonActive()]);
    if (seq !== ownSeq) {
      return; // a newer choice or poll superseded this one
    }
    own = { r, collecting, at: Date.now() };
    log?.info(`panel: ${cli.windowLabel(w)} report fetched in ${Date.now() - t}ms`);
    draw();
  } catch (e) {
    if (seq === ownSeq) {
      fail((e as Error).message);
    }
  } finally {
    if (seq === ownSeq) {
      ownRunning = undefined;
    }
  }
}

// Redraws with the current colors after a theme change.
export function redraw(): void {
  draw();
}

export function fail(message: string, setup?: cli.Setup): void {
  latest = { error: message, setup };
  draw();
}

function draw(): void {
  if (!activityPanel || !latest) {
    return;
  }
  const n = nonce();
  if ("error" in latest) {
    activityPanel.webview.html = errorBody(latest.error, n, latest.setup);
    return;
  }
  // Until the chosen window's first report arrives, keep showing the page as
  // it is rather than redrawing the poll's window under the new label.
  if (pick && !own) {
    return;
  }
  const data = pick ? own! : latest;
  const w = activityPanel.webview;
  const font = extensionUri ? w.asWebviewUri(vscode.Uri.joinPath(extensionUri, "assets", "kaimon-actors.woff")).toString() : "";
  const t = Date.now();
  w.html = activityBody(data.r, data.collecting, n, { font, csp: w.cspSource, glyphs }, view, data.at, selected());
  if (openedAt) {
    log?.info(`panel: drawn ${Date.now() - openedAt}ms after the click (render ${Date.now() - t}ms)`);
  }
}

export async function showReport(window = cli.currentWindow()): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    "kaimon.report",
    "AIM Report",
    vscode.ViewColumn.One,
    { enableScripts: true, enableFindWidget: true },
  );
  const n = nonce();
  panel.webview.html = errorBody("Rendering report…", n);
  try {
    // HTML and JSON fetched together, so the two saved files describe the same
    // moment, as the portal's HTML/JSON pair describe the same report.
    const [html, json] = await Promise.all([cli.reportHTML(window), cli.reportJSON(window)]);
    const opened = new Date();
    // The toolbar's two dropdowns act on the CLI's output — exactly the files
    // `-format html` and the default JSON give, without the toolbar or the CSP
    // below, so each copy stands on its own. Open in Browser opens it in the browser of the
    // machine the user sits at (browser.ts: VS Code has no built-in for that);
    // Download is VS Code's save dialog, which opens on the remote disk and
    // reaches the client's through its "Show Local" button, so no
    // local/remote choice is needed here. Same on a local window.
    panel.webview.onDidReceiveMessage(async (m) => {
      const ext = m?.format === "json" ? "json" : m?.format === "html" ? "html" : "";
      if (!ext || (m?.command !== "view" && m?.command !== "download")) {
        return;
      }
      const d = opened;
      const p2 = (x: number) => String(x).padStart(2, "0");
      const name = `kaimon-aim-report-${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
        `-${p2(d.getHours())}${p2(d.getMinutes())}-${window}.${ext}`;
      const body = ext === "json" ? json : html;
      if (m.command === "view") {
        try {
          await browser.open(name, body, ext === "json" ? "application/json" : "text/html");
        } catch (e) {
          void vscode.window.showErrorMessage(`Could not open the browser: ${(e as Error).message}`);
        }
        return;
      }
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
      const uri = await vscode.window.showSaveDialog({
        defaultUri: folder ? vscode.Uri.joinPath(folder, name) : undefined,
        filters: ext === "json" ? { JSON: ["json"] } : { HTML: ["html"] },
        saveLabel: `Save ${ext.toUpperCase()}`,
      });
      if (uri) {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(body));
        void vscode.window.showInformationMessage(`Saved the AIM report to ${uri.fsPath}`);
      }
    });
    // The portal's buttons and dropdown, same styles and lucide icons: the
    // reports list's "Download ▾" (report-row__dropdown in the dashboard's
    // globals.css), and an "Open in Browser ▾" beside it (it said "View" for an
    // hour on 2026-10-01: unclear inside a tab that already shows it), the
    // job of the report viewer's "New Tab". Replaced a VS Code menu on
    // 2026-10-01 (Dirk: should look like the portal). The portal's
    // "← Reports" and date are left out — the AIM tab sits beside this one, and
    // the report's own header carries the date — as are PDF and fullscreen:
    // the CLI renders no PDF, and VS Code maximizes an editor itself.
    const icon = (d: string, size = 14) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" ` +
      `stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
    const doc = `<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>`;
    const fileText = icon(`${doc}<path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>`, 13);
    const fileJson = icon(`${doc}<path d="M10 12a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1"/>` +
      `<path d="M14 18a1 1 0 0 0 1-1v-1a1 1 0 0 1 1-1 1 1 0 0 1-1-1v-1a1 1 0 0 0-1-1"/>`, 13);
    const external = icon(`<path d="M15 3h6v6"/><path d="M10 14 21 3"/>` +
      `<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>`);
    const download = icon(`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/><path d="M12 15V3"/>`);
    const chevron = `<span class="rv-chev">${icon(`<path d="m6 9 6 6 6-6"/>`, 12)}</span>`;
    const menu = (cmd: string, label: string, glyph: string, title: string) =>
      `<div class="rv-wrap"><button class="rv-action" data-menu="${cmd}" title="${title}">${glyph}<span>${label}</span>${chevron}</button>` +
      `<div class="rv-menu" id="rvMenu-${cmd}">` +
      `<button class="rv-item" data-cmd="${cmd}" data-format="html">${fileText}HTML</button>` +
      `<button class="rv-item" data-cmd="${cmd}" data-format="json">${fileJson}JSON</button></div></div>`;
    const toolbar =
      // Fit to width, like a PDF viewer: the PAGE keeps its designed 1050px
      // layout and scales down when the tab is narrower, never up; reflowing
      // squeezed the KPI rows and table columns (2026-09-26). The toolbar is
      // not scaled — its buttons belong to the tab, not the report — and only
      // follows the page's width, so they stay at its right edge. Around the
      // page, the cloud report's own surroundings, as a browser shows it: the
      // light gray #f8fafc canvas, the page centered, 60px below. The report's
      // frame mode, built for the portal, makes the canvas transparent and pins
      // the page left; the tab undoes that. Tab only: the saved files are the
      // CLI's, untouched.
      `<style>.container { width: 1050px; max-width: none; }\n` +
      `html, body.in-portal { background-color: #f8fafc; }\n` +
      `body.in-portal { padding: 0 32px 60px; } body.in-portal .container { margin: 0 auto; }\n` +
      `.rv-header { width: 1050px; margin: 0 auto 16px; padding: 20px 0 16px; display: flex; align-items: center;` +
      ` justify-content: flex-end; border-bottom: 1px solid rgba(43, 100, 147, 0.1); font-family: 'Inter', sans-serif; }\n` +
      `.rv-actions { display: flex; align-items: center; gap: 6px; }\n` +
      `.rv-action { display: inline-flex; align-items: center; gap: 5px; padding: 7px 12px; font: 600 12px 'Inter',` +
      ` sans-serif; color: #475569; background: #f8fafc; border: 1px solid rgba(43, 100, 147, 0.1);` +
      ` border-radius: 6px; cursor: pointer; transition: all 0.15s; white-space: nowrap; }\n` +
      `.rv-action:hover, .rv-action.open { background: #f0f7fb; color: #2B6493; border-color: rgba(43, 100, 147, 0.2); }\n` +
      `.rv-chev { display: inline-flex; opacity: 0.6; }\n` +
      `.rv-wrap { position: relative; }\n` +
      `.rv-menu { display: none; position: absolute; top: calc(100% + 4px); right: 0; min-width: 130px; background: #ffffff;` +
      ` border: 1px solid rgba(43, 100, 147, 0.1); border-radius: 8px; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.10);` +
      ` z-index: 50; padding: 4px; flex-direction: column; gap: 2px; }\n` +
      `.rv-menu.open { display: flex; }\n` +
      `.rv-item { display: flex; align-items: center; gap: 8px; width: 100%; padding: 6px 10px; font: 600 12px 'Inter',` +
      ` sans-serif; color: #475569; background: transparent; border: none; border-radius: 6px; cursor: pointer;` +
      ` text-align: left; transition: background 0.12s, color 0.12s; white-space: nowrap; }\n` +
      `.rv-item:hover { background: #f0f7fb; color: #2B6493; }</style>` +
      `<div class="rv-header" id="rvHeader"><div class="rv-actions">` +
      // Download first, Open in Browser at the edge: the portal viewer's order,
      // HTML · JSON · PDF · New Tab, where the action leaving the page is last.
      menu("download", "Download", download, "Download") +
      menu("view", "Open in Browser", external, "Open in your browser") +
      `</div></div>` +
      `<script nonce="${n}">const k = acquireVsCodeApi();\n` +
      `const close = () => document.querySelectorAll('.rv-menu.open, .rv-action.open').forEach(e => e.classList.remove('open'));\n` +
      `document.querySelectorAll('[data-menu]').forEach(b => b.addEventListener('click', (e) => {\n` +
      `  e.stopPropagation(); const m = document.getElementById('rvMenu-' + b.dataset.menu);\n` +
      `  const was = m.classList.contains('open'); close(); if (!was) { m.classList.add('open'); b.classList.add('open'); } }));\n` +
      `document.querySelectorAll('[data-cmd]').forEach(i => i.addEventListener('click', (e) => {\n` +
      `  e.stopPropagation(); close(); k.postMessage({ command: i.dataset.cmd, format: i.dataset.format }); }));\n` +
      `document.addEventListener('click', close);\n` +
      `document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { close(); } });\n` +
      `const fit = () => { const z = Math.min(1, (window.innerWidth - 64) / 1050);\n` +
      `  const page = document.querySelector('.container'); if (page) { page.style.zoom = z; }\n` +
      `  document.getElementById('rvHeader').style.width = (1050 * z) + 'px'; };\n` +
      `document.addEventListener('DOMContentLoaded', fit);\n` +
      `window.addEventListener('resize', fit); fit();</script>`;
    // The report carries exactly one inline <script>, which adds a class when
    // the document finds itself framed. A webview IS a frame, so it fires and
    // strips the page chrome — which is what we want here. It needs the nonce
    // to survive the CSP.
    //
    // style-src is 'unsafe-inline' with NO nonce, and that combination is
    // deliberate: under CSP2+ a nonce or hash in a source list causes
    // 'unsafe-inline' to be IGNORED for that directive. The report carries 241
    // inline style="" attributes (measured 2026-09-19), which a nonce cannot
    // cover — nonces apply to elements, not attributes — so nonce + unsafe-inline
    // would have silently stripped the layout. script-src stays nonce-only,
    // which is where the risk actually is.
    panel.webview.html = html
      .replace(
        "<head>",
        `<head>\n<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-${n}';">`,
      )
      .replace(/<script>/g, `<script nonce="${n}">`)
      .replace(/<style>/g, `<style nonce="${n}">`)
      .replace("<body>", `<body>\n${toolbar}`);
  } catch (e) {
    panel.webview.html = errorBody((e as Error).message, nonce());
  }
}
