// The panel's timeline: the dashboard's TIMELINE card for the panel's window.
//
// A port of the CLI's render.timeline (itself a port of the cloud's
// generate_timeline_svg): the same 800x120 canvas, dual axis, smooth curves
// and gridlines — so a reader who knows the dashboard reads this without
// learning anything. The dashboard's definitions, drawn differently:
//
//   Risk Findings — every log that is not noise, CRITICAL to LOW, colored per
//          slot by its worst severity, dots from MEDIUM up. Sums to the
//          severity strip and to the header's "N flagged changes".
//   File Changes — every log, noise included — the dashboard's File Change
//          Logs, in kaimon's brand blue #2563eb. Above the risk line's total
//          by exactly the noise.
//
// Time differs too. Slots are the CLI's, clock-aligned (the instant of slot i
// is meta.start_time + i * meta.bucket_seconds), and labels are local times
// in the user's own clock format (row.tickOf: "3 PM", "3:05" or "15:05"),
// where the dashboard is always 24-hour. The line's colors are the
// severity palette, as stroke attributes — presentation attributes, which the
// panel's CSP allows where it allows no style attribute; everything neutral is
// a class in the panel's nonce'd stylesheet, in the theme's own colors.
import * as cli from "./cli";
import * as row from "./row";

const W = 800;
const H = 120;
const PAD = { top: 25, bottom: 30, left: 30, right: 30 };
const CW = W - PAD.left - PAD.right;
const CH = H - PAD.top - PAD.bottom;

// render.go niceMax: the axis top as three round gridline steps.
function niceMax(v: number): number {
  if (v <= 0) {
    return 3;
  }
  for (const s of [1, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60,
    75, 80, 100, 120, 150, 200, 250, 300, 400, 500, 600, 750, 1000]) {
    if (3 * s >= v) {
      return 3 * s;
    }
  }
  const mag = Math.pow(10, Math.floor(Math.log10(v / 3)));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) {
    if (3 * m * mag >= v) {
      return Math.round(3 * m * mag);
    }
  }
  return Math.ceil(v / 3000) * 3000;
}

// render.go smoothPath: cubic segments with horizontal tangents.
function smooth(ps: [number, number][]): string {
  if (ps.length < 2) {
    return "";
  }
  let d = `M ${ps[0][0].toFixed(1)},${ps[0][1].toFixed(1)}`;
  for (let i = 0; i < ps.length - 1; i++) {
    const [x0, y0] = ps[i];
    const [x1, y1] = ps[i + 1];
    const dx = x1 - x0;
    d += ` C ${(x0 + dx / 2).toFixed(1)},${y0.toFixed(1)} ${(x1 - dx / 2).toFixed(1)},${y1.toFixed(1)} ` +
      `${x1.toFixed(1)},${y1.toFixed(1)}`;
  }
  return d;
}

// render.go tickEvery: the smallest of 1m, 5m, 15m, 1h, 2h leaving 12 labels
// or fewer — the dashboard's day has 12. From the span without the last slot,
// which is the partial "now".
function tickEvery(seconds: number): number {
  for (const t of [60, 300, 900, 3600]) {
    if (seconds <= 12 * t) {
      return t;
    }
  }
  return 7200;
}


// "1h" -> "1H", "24h" -> "24H", "10m" -> "10M": the dashboard's TIMELINE (24H).
export function span(window: string): string {
  return window.toUpperCase();
}

const ORDER = ["CRITICAL", "HIGH", "MEDIUM", "LOW"];

// An axis value that fits the 30-unit margins: "7500", then "22.5k", "60k".
// Five digits did not fit and were clipped at the canvas edge ("!2500",
// "6000(", seen 2026-09-26 on a day with a 60,000-change spike).
function axis(v: number): string {
  if (v < 10_000) {
    return String(v);
  }
  const k = v / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
}

// A slot's worst severity, or undefined for a slot with nothing flagged. A CLI
// that predates per-slot severities reads as LOW, which is what the strip
// would say about an unrated log.
// A slot's count for one severity, from the list the CLI emits.
const sevOf = (b: cli.Bucket, k: string) => b.severity_counts?.find((s) => s.name === k)?.count ?? 0;

function worstOf(b: cli.Bucket): string | undefined {
  if (b.file_changes_risk <= 0) {
    return undefined;
  }
  return ORDER.find((k) => sevOf(b, k) > 0) ?? "LOW";
}

const worse = (a?: string, b?: string) =>
  a === undefined ? b : b === undefined ? a : ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b;


// The chart, or "" when the report has no clock-aligned slots (a CLI older
// than them) — no timeline beats one on the wrong clock.
//
// The risk line is colored per slot by that slot's worst severity (Dirk,
// 2026-09-25): a CRITICAL turns it red exactly where it happened and nowhere
// else, and a LOW-only window never shows red. File changes stay a plain blue
// line in kaimon's brand blue #2563eb, distinct from LOW's slate. A gray area,
// the dashboard's #2B6493 (too dark on a dark panel) and the theme's chart
// blue (as light as LOW, so the two lines blurred) were tried the same day and
// dropped.
export function svg(r: cli.Report): string {
  const bs = r.timeseries ?? [];
  const size = r.meta.bucket_seconds ?? 0;
  const t0 = Date.parse(r.meta.start_time);
  if (bs.length < 2 || size <= 0 || Number.isNaN(t0)) {
    return "";
  }
  const at = (i: number) => new Date(t0 + i * size * 1000);
  const n = bs.length - 1;
  const x = (i: number) => PAD.left + (i / n) * CW;
  const rawFlag = Math.max(...bs.map((b) => b.file_changes_risk));
  const rawLogs = Math.max(...bs.map((b) => b.file_changes));
  const maxLogs = niceMax(rawLogs);
  // One shared axis while the two series are within 10x of each other, so File
  // Changes visibly sits above Risk Findings (it always counts at least as
  // many); two axes only when risk would be a flat line on the file-change
  // scale. The report's chart uses the same rule (render.go).
  const maxFlag = rawFlag * 10 >= rawLogs ? maxLogs : niceMax(rawFlag);
  const y = (v: number, max: number) => H - PAD.bottom - (v / max) * CH;
  const base = H - PAD.bottom;
  const worst = bs.map(worstOf);
  const overall = worst.reduce<string | undefined>((a, w) => worse(a, w), undefined);
  // The zero stretches of the line take the window's calmest color present:
  // LOW's slate, or the neutral gray when nothing at all was flagged.
  const quiet = overall ? cli.SEVERITY_LINE.LOW : "";
  const stroke = (k?: string) => (k ? cli.SEVERITY_LINE[k] : quiet);
  const pt = (i: number): [number, number] => [x(i), y(bs[i].file_changes_risk, maxFlag)];

  const out: string[] = [];
  for (let k = 0; k < 4; k++) {
    const gy = PAD.top + k * (CH / 3);
    const v = 3 - k;
    out.push(`<line class="tl-grid" x1="${PAD.left}" y1="${gy}" x2="${W - PAD.right}" y2="${gy}"/>`);
    out.push(`<text class="tl-axis" x="${PAD.left - 5}" y="${gy + 4}" text-anchor="end">${axis((maxFlag * v) / 3)}</text>`);
    out.push(`<text class="tl-axis" x="${W - PAD.right + 5}" y="${gy + 4}">${axis((maxLogs * v) / 3)}</text>`);
  }

  // Shading for the row under the mouse (rows \u2192 timeline), drawn by the page
  // script; first, so it sits behind both lines.
  out.push(`<g id="tlBands"></g>`);
  // File changes first, so the risk line draws over it.
  out.push(`<path class="tl-logs" d="${smooth(bs.map((b, i) => [x(i), y(b.file_changes, maxLogs)]))}"/>`);

  // Risk findings: one path per run of equal color. A segment takes the
  // worse of its two ends, so a spike is colored on both flanks.
  let run: [number, number][] = [pt(0)];
  let runColor = stroke(worse(worst[0], worst[1]));
  const flush = () => {
    out.push(`<path class="tl-flag${runColor ? "" : " tl-none"}"${runColor ? ` stroke="${runColor}"` : ""} ` +
      `d="${smooth(run)}"/>`);
  };
  for (let i = 0; i < n; i++) {
    const c = stroke(worse(worst[i], worst[i + 1]));
    if (c !== runColor) {
      flush();
      run = [pt(i)];
      runColor = c;
    }
    run.push(pt(i + 1));
  }
  flush();
  // Dots only from MEDIUM up: they mark the incidents, and LOW is the
  // background they stand out from.
  bs.forEach((_, i) => {
    const w = worst[i];
    if (w && w !== "LOW") {
      const [cx, cy] = pt(i);
      out.push(`<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="2.5" fill="${cli.SEVERITY_LINE[w]}"/>`);
    }
  });

  // Labels on clock times in the local zone. Every slot size divides 15
  // minutes and every real zone offset is whole quarter hours, so a tick that
  // is round locally is always a slot boundary.
  const tick = tickEvery(n * size);
  bs.forEach((_, i) => {
    const t = at(i);
    const sec = t.getHours() * 3600 + t.getMinutes() * 60 + t.getSeconds();
    if (sec % tick === 0) {
      out.push(`<text class="tl-axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="middle">${row.tickOf(t)}</text>`);
      out.push(`<line class="tl-tick" x1="${x(i).toFixed(1)}" y1="${base}" x2="${x(i).toFixed(1)}" y2="${base + 4}"/>`);
    }
  });

  // The dashboard's axis pointer: a dashed guide at the slot under the
  // mouse and a marker on each line, hidden until the page script moves them.
  out.push(`<line class="tl-guide" id="tlGuide" x1="0" y1="${PAD.top}" x2="0" y2="${base}" visibility="hidden"/>`);
  out.push(`<circle class="tl-mk tl-mk-logs" id="tlMkLogs" r="3" visibility="hidden"/>`);
  out.push(`<circle class="tl-mk" id="tlMkRisk" r="3" visibility="hidden"/>`);

  // One transparent strip per slot, carrying what the popup shows. The page
  // script reads these; the chart itself stays static markup.
  const half = CW / n / 2;
  bs.forEach((b, i) => {
    const s = row.timeOf(at(i), size < 60);
    const split = ORDER.filter((k) => sevOf(b, k) > 0)
      .map((k) => `${sevOf(b, k).toLocaleString()} ${k.toLowerCase()}`);
    const [cx, cy] = pt(i);
    out.push(`<rect class="tl-hit" data-i="${i}" x="${(cx - half).toFixed(1)}" y="${PAD.top}" width="${(2 * half).toFixed(1)}" ` +
      `height="${CH}" data-x="${cx.toFixed(1)}" data-yr="${cy.toFixed(1)}" ` +
      `data-yl="${y(b.file_changes, maxLogs).toFixed(1)}" data-t="${s}" ` +
      `data-logs="${b.file_changes.toLocaleString()}" data-risk="${b.file_changes_risk.toLocaleString()}" ` +
      `data-split="${split.length > 1 || (worst[i] && worst[i] !== "LOW") ? split.join(" \u00b7 ") : ""}" ` +
      `data-c="${stroke(worst[i]) || ""}"/>`);
  });

  const legendLine = overall ? ` stroke="${cli.SEVERITY_LINE[overall]}"` : "";
  out.push(`<g transform="translate(${PAD.left}, 10)"><line class="tl-flag${overall ? "" : " tl-none"}"${legendLine} ` +
    `x1="0" y1="0" x2="15" y2="0"/><text class="tl-legend" x="20" y="3">Risk Findings</text></g>`);
  out.push(`<g transform="translate(${W - PAD.right - 78}, 10)"><line class="tl-logs" x1="0" y1="0" x2="15" y2="0"/>` +
    `<text class="tl-legend" x="20" y="3">File Changes</text></g>`);
  return `<svg class="tl-chart" viewBox="0 0 ${W} ${H}" data-top="${PAD.top}" role="img" aria-label="Timeline">` +
    `${out.join("")}</svg>` +
    // The popup, after the dashboard's: the slot's time, then one row per
    // line with its color dot. The severity split shows only when it says
    // more than "all LOW".
    `<div class="tl-tip" id="tlTip" hidden><div class="tt-h" id="ttTime"></div>` +
    `<div class="tt-r"><span class="tt-d tt-logs"></span><span class="tt-k">File Changes</span><b id="ttLogs"></b></div>` +
    `<div class="tt-r"><span class="tt-d" id="ttDot"></span><span class="tt-k">Risk Findings</span><b id="ttRisk"></b></div>` +
    `<div class="tt-s" id="ttSplit"></div></div>`;
}
