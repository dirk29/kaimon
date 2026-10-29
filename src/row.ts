// One row of the activity list, as data.
//
// The hover and the panel draw the SAME line: a user who notices a row in the
// hover opens the panel to find it again, one level deeper. They did not
// share it at first. The panel had its own chain, age format, filter and order,
// written before the hover settled, and on 2026-09-22 it showed 1 of the
// hover's 10 rows, with a different label, actor rendering and age in the one
// row it did show. Two implementations of one line drift apart; this module is
// the one implementation, and each surface decides only how to draw it.
//
// No vscode import, so it runs headless under the tests.

import * as cli from "./cli";

export interface Row {
  // The matched rule's description: the risk badge's tooltip in the panel.
  description: string;
  group: cli.Group;
  // CRITICAL, HIGH, MEDIUM or LOW. Anything unrecognized is drawn as LOW.
  severity: string;
  // The rule category with plain spaces: "SESSION WRITE".
  category: string;
  // The actor's icon id, or null when no agent is named.
  mark: string | null;
  // The actor the mark stands for, "" when none; the panel shows it as the
  // mark's tooltip, since a specific mark replaces the name in the chain.
  agent: string;
  // Neither an agent nor a tool: drawn as a dash where the mark would be.
  unattributed: boolean;
  // What the actor acted through, in order. Plain text, not escaped.
  chain: string[];
  // file_pattern as the CLI emitted it — a glob that can be pasted. "" if none.
  pattern: string;
  // Log records — the "#" column. The raw unit, and the one the report's Logs
  // column already uses. NOT Group.files: that counts one workload per file
  // per full process name, thread included, so one settings.json written by
  // two claude worker threads ("Bun Pool 0", "Bun Pool 1") showed # 2 for a
  // single file with three writes.
  logs: number;
  // "3:28 \u2192 4:25pm", or a single time when both ends agree: the panel's.
  seen: string;
  // "4:25pm": the most recent end alone, the hover's Seen.
  last: string;
}

// Times in the user's own format (Dirk, 2026-09-25): "3:08 PM" where the
// locale uses a 12-hour clock, "15:08" where it uses 24 — VS Code runs
// everywhere, so no single clock is right. The locale is the extension host's
// default, the same one that already renders the footer's "Updated 3:59:00
// PM", so a hover never mixes the two. (Over SSH that is the remote machine's
// locale and zone, not the client's; the hover is built there, so it cannot
// be otherwise.)
const HM = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const HMS = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit", second: "2-digit" });
const H12 = HM.resolvedOptions().hourCycle === "h12" || HM.resolvedOptions().hourCycle === "h11";
const HOUR = new Intl.DateTimeFormat(undefined, { hour: "numeric" });

// "3:08pm", not "3:08 PM" (Dirk, 2026-09-25, final after trying "3:08 pm").
// Only a Latin AM/PM AFTER the time is folded; 24-hour locales and
// period-first ones ("PM 3:08" in ko) are left as the locale wrote them.
function fold(s: string): string {
  return s.replace(/\s*\b(AM|PM)$/, (_m, p: string) => p.toLowerCase());
}

// "3:08pm" / "15:08"; with seconds for sub-minute timeline slots.
export function timeOf(t: Date, seconds = false): string {
  return fold((seconds ? HMS : HM).format(t));
}

// The time without its AM/PM, and where that mark sits: after the time in
// English, before it in some locales ("오후 3:08").
function bare(t: Date): { text: string; periodFirst: boolean } {
  const ps = HM.formatToParts(t);
  const p = ps.findIndex((x) => x.type === "dayPeriod");
  const h = ps.findIndex((x) => x.type === "hour");
  const text = ps.filter((x) => x.type !== "dayPeriod").map((x) => x.value).join("").trim();
  return { text, periodFirst: p >= 0 && p < h };
}

// A timeline tick: "3pm" on the hour and "3:05" between in 12-hour locales,
// which is how their clocks and charts label an axis; "15:05" in 24-hour ones.
export function tickOf(t: Date): string {
  if (!H12) {
    return HM.format(t);
  }
  return t.getMinutes() === 0 ? fold(HOUR.format(t)) : bare(t).text;
}

// Seen, on both surfaces: first to last, or one time when both ends fall in
// the same minute. "3:28 \u2192 4:25pm" writes am/pm once when both ends share
// it, "11:58am \u2192 12:03pm" when they do not (Dirk, 2026-09-25, final after
// en-dash variants); "14:59\u201315:56" in 24-hour
// locales. For a group, or one file inside it, so a file reads exactly like
// its row.
//
// It was relative ("27m \u2192 48m", headed "Seen (ago)") until the panel grew
// a timeline. Clock times read against its axis, and they do not go stale: a
// relative time in a hover left open became wrong while it sat there;
// "3:31pm" stays true. A range only appears when the activity actually spans
// minutes, so the dash itself says "sustained" rather than "one write".
//
// A time on an earlier day than the window's end carries a superscript day
// offset, "11:50pm\u207b\u00b9" — never a date (Dirk, 2026-10-02). Measured in
// LOCAL days against end, the window's last instant: every window here ends
// now, so today's times carry no mark and yesterday's read -1. It counted from
// the window's START until 2026-10-12, the portal's convention for a report
// of one fixed day; on a window ending now that marked all of today +1, which
// reads as tomorrow (Dirk: "this is today!!!"). Unicode superscripts, so the
// mark survives escaping and the hover's sanitizer; the panel restyles it
// (dayOffsetHTML).
export function clock(first: string | undefined, last: string | undefined, end?: string): string {
  const ok = (iso?: string) => (iso && !isNaN(Date.parse(iso)) ? new Date(iso) : undefined);
  const f = ok(first) ?? ok(last);
  const l = ok(last) ?? f;
  if (!f || !l) {
    return "";
  }
  const e = ok(end);
  const mf = e ? dayMark(f, e) : "";
  const ml = e ? dayMark(l, e) : "";
  const [ff, lf] = [timeOf(f) + mf, timeOf(l) + ml];
  if (ff === lf) {
    return lf;
  }
  if (H12 && mf === ml && (f.getHours() < 12) === (l.getHours() < 12)) {
    const [bf, bl] = [bare(f), bare(l)];
    return bf.periodFirst ? `${ff} \u2192 ${bl.text}${ml}` : `${bf.text}${mf} \u2192 ${lf}`;
  }
  return `${ff} \u2192 ${lf}`;
}

const SUPER = "\u2070\u00b9\u00b2\u00b3\u2074\u2075\u2076\u2077\u2078\u2079";

// "\u207b\u00b9" when t falls n > 0 local days before end, else "".
function dayMark(t: Date, end: Date): string {
  const day = (d: Date) => Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const n = Math.round((day(end) - day(t)) / 86_400_000);
  return n > 0 ? "\u207b" + [...String(n)].map((c) => SUPER[Number(c)]).join("") : "";
}

// The panel's rendering of a day mark: the portal's small gray <sup>, applied
// to text already HTML-escaped.
export function dayOffsetHTML(escaped: string): string {
  return escaped.replace(/\u207b([\u2070\u00b9\u00b2\u00b3\u2074-\u2079]+)/g, (_, d: string) =>
    `<sup class="dayoff">\u2212${[...d].map((c) => SUPER.indexOf(c)).join("")}</sup>`);
}

export function seen(g: cli.Group, end?: string): string {
  return clock(g.first_seen, g.last_seen, end);
}

// Severity, then rule PRIORITY, then recency, then log count — the same
// order the report uses, so a row ranks alike on all three surfaces.
//
// Priority was LAST until 2026-09-23, on the argument that it is a property
// of the rule and this surface is about what just happened. That reversed
// because priority stopped being noise: AIM's tiers had collisions everywhere
// (eleven LOW rules at 6), so it could not have led even if it were first.
// With every tier numbered 1..N — enforced by a test, as FIM always was — it
// now carries a real judgment: within LOW, an agent's source edits outrank
// its build output, which outranks its own session cache. Sorting it last
// let a one-minute-old SESSION_CACHE row push a ten-minute-old SOURCE_EDIT
// out of the hover, and no amount of recency makes cache more relevant.
//
// Recency then decides among rows of the same rule, so the live row leads.
// Size breaks what is left: it stops three near-identical rows from burying
// a large one when they report the same minute. Size is the LOG count, the
// number the "#" column shows.
//
// Recency is compared at the granularity the column DISPLAYS, not at raw
// millisecond resolution: everything under a minute is one bucket, then
// whole minutes, hours, days.
//
// Without this the sort discriminates on differences the reader cannot
// see. Observed 2026-09-21: the top five rows spanned 120s-166s and every
// one of them rendered "2m", yet a 12-file SANDBOX_SETUP sat below a
// 1-file row because it was two seconds older. Bucketing makes those rows
// tie, so the log count decides and the bigger group leads.
//
// It also removes most of the refresh churn: the order can only change
// when a displayed value changes.
function seenBucket(g: cli.Group, now: number): number {
  const secs = Math.max(0, (now - Date.parse(g.last_seen)) / 1000);
  if (isNaN(secs) || secs < 60) {
    return 0;
  }
  const mins = Math.floor(secs / 60);
  if (mins < 60) {
    return mins;
  }
  const hours = Math.floor(mins / 60);
  return hours < 24 ? hours * 60 : Math.floor(hours / 24) * 1440;
}
// Priority restarts at 1 in every severity tier, and 0 means unranked, so an
// unranked rule must sort last rather than first.
function prio(g: cli.Group): number {
  return g.risk_priority || Number.MAX_SAFE_INTEGER;
}
function rank(g: cli.Group): number {
  return ["CRITICAL", "HIGH", "MEDIUM", "LOW"].indexOf(g.risk_severity ?? "LOW");
}

// A stable identity for a group across refreshes: the digest's own grouping
// key. file_pattern and common_path are deliberately NOT in it — both change
// as files arrive, and a row the user opened would close the moment its
// pattern grew by one extension.
export function key(g: cli.Group): string {
  // The device left the digest's key on 2026-09-23, so it is not here either:
  // a row that spans tmpfs and the root disk is one row with one identity.
  return JSON.stringify([g.risk_severity, g.risk_category, g.agent, g.tool, g.process, g.user]
    .map((v) => v ?? ""));
}

// Display form of an actor name. The records carry them lowercase, as the
// process is actually named, but the subheader is prose about a product whose
// subject IS these agents — so they read as proper nouns there. The table keeps
// the raw names, which is what you would grep for.
//
// MCP uppercases whole: it is an acronym, and "Mcp" looks like a typo. The
// boundary check keeps "mcp-git" rendering as "MCP-git" rather than "Mcp-git".
// Products whose own spelling is not just a capital first letter.
const AGENT_SPELLING: Record<string, string> = {
  opencode: "OpenCode",
};

export function agentLabel(a: string): string {
  if (/^mcp\b/i.test(a)) {
    return "MCP" + a.slice(3);
  }
  return AGENT_SPELLING[a.toLowerCase()] ?? a.charAt(0).toUpperCase() + a.slice(1);
}

// The product an actor name stands for, for the tooltip over its mark: the
// mark replaces the name in the table, so the tooltip is where a reader who
// does not know the glyph learns whose it is. Only where the product's name
// says more than agentLabel does; every other actor gets agentLabel.
const AGENT_PRODUCT: Record<string, string> = {
  claude: "Claude Code",
  copilot: "GitHub Copilot",
  gemini: "Gemini CLI",
  kilo: "Kilo Code",
  qwen: "Qwen Code",
  mcp: "MCP server",
};

export function agentProduct(a: string): string {
  return AGENT_PRODUCT[a.toLowerCase()] ?? agentLabel(a);
}

// FINAL (Dirk, 2026-10-01): "Claude, Codex raised risk findings for 44 file
// changes" in the hover, "... out of 2,016 total" in the panel — the report's
// own term, and the panel one level of detail deeper than the hover. Shared by the
// hover's subheader and the panel's context line. "Flagged": each matched a
// risk rule, LOW or above
// — the security term for exactly that; the severity strip right below says
// how badly, and the timeline's Risk Findings line carries the same total.
// Final 2026-09-25 (Dirk), after trying "noted" (softer, but says nothing
// about why), "potential-risk" (too long), "classified" (every change is
// classified, noise included, and it reads as "secret"), "tracked" (false the
// same way) and "risky" (overstates LOW). The qualifier stays on both
// surfaces: without it "made 581 changes" reads as everything the agents did,
// which is several times more.
//
//
// Since 2026-09-29 both numbers are the report's KPI tiles, Anomalies Detected
// and File Change Logs, the same pair its workloads footer reads as "(44
// Anomalies) in 2,016 Total Logs", and the timeline's red and blue lines sum to
// them. "file changes" names the blue line, File Changes. Before, the numbers
// were the ROWS' (the "#" column), which differs once the rows are cut at the
// top 20: on one day 184 against 805 flagged. The footer's "Top 20 of 29" says
// why the "#" column can sum to less. No file count: the Files tile counts the
// files of ALL changes (1,131 in an hour whose flagged changes touched 60), so
// "in N files" after the flagged changes would be false, and there is no
// flagged-files number to put there. Lowercase: this is a sentence, not a label.
// "out of", not "of" (Dirk, 2026-09-30): reads as a share of the total.
// "raised", not "made" (Dirk, 2026-10-01): the report's Security Summary says
// "raised N risk findings", and the two read the same verb.
export function changesBy(names: string, logs: number, flagged: number, withTotal: boolean): string {
  // Zero keeps the sentence and swaps the number: "raised risk findings for 0
  // file changes" named agents as raising findings while saying there were none.
  if (flagged === 0) {
    return `${names} raised no risk findings`;
  }
  const s = flagged === 1 ? "" : "s";
  const total = withTotal ? ` out of ${logs.toLocaleString()} total` : "";
  return `${names} raised risk findings for ${flagged.toLocaleString()} file change${s}${total}`;
}

// The header both surfaces show above the rows: who was active and what they
// did, and the four severity counts with the color each
// is drawn in. Shared for the same reason the rows are — the panel repeats the
// hover 1:1 and adds only the expansion.
export interface Summary {
  collecting: boolean;
  agents: string[];
  // The report's KPI tiles: File Change Logs and Anomalies Detected.
  logs: number;
  flagged: number;
  // CRITICAL, HIGH, MEDIUM, LOW. A zero is drawn in the dim shade.
  tiers: { k: string; n: number; color: string; dim: boolean }[];
  // The worst severity present, or undefined when there is nothing. It colors
  // the TOP FINDINGS icon on both surfaces: a warning when there are findings,
  // an info mark when there is only LOW.
  worst?: { k: string; color: string };
}

export function summary(r: cli.Report, collecting: boolean): Summary {
  const counts = cli.severityCounts(r);
  const worst = ["CRITICAL", "HIGH", "MEDIUM", "LOW"].find((k) => counts[k] > 0);
  return {
    collecting,
    worst: worst ? { k: worst, color: cli.SEVERITY_COLOR[worst] } : undefined,
    agents: cli.agentNames(r),
    logs: r.kpi?.file_changes ?? 0,
    flagged: r.kpi?.file_changes_risk ?? 0,
    tiers: ["CRITICAL", "HIGH", "MEDIUM", "LOW"].map((k) => ({
      k,
      n: counts[k],
      dim: counts[k] === 0,
      color: counts[k] === 0 ? cli.SEVERITY_DIM[k] : cli.SEVERITY_COLOR[k],
    })),
  };
}

// "Updated 3:37:59pm" — an absolute clock time, correct whenever it is read,
// in the same compact form as Seen above it.
export function updatedAt(at: number): string {
  return timeOf(new Date(at), true);
}

// "Top 10 of 19 · Host ubu26:/ · Updated 3:37:59pm". The window is not here:
// it leads the header line instead ("Last 1h Agents …"), where it scopes the
// numbers it belongs to. The caller passes its own escaper: markdown for the
// hover, HTML for the panel.
export function footerText(shown: number, total: number, host: string,
  at: number, esc: (s: string) => string = (s) => s): string {
  return `Top ${shown} of ${total} \u00b7 Host ${esc(host)}:/ \u00b7 Updated ${updatedAt(at)}`;
}

// Every group, worst first. Returns a new array; the report is not reordered.
export function ranked(groups: cli.Group[], now = Date.now()): cli.Group[] {
  return groups.slice().sort((a, b) =>
    rank(a) - rank(b) ||
    prio(a) - prio(b) ||
    seenBucket(a, now) - seenBucket(b, now) ||
    b.count - a.count);
}

// The Agent column, rendered as the report renders it:
//   {{Agent}} > {{Tool}} > {{Process}}, each dropped when empty or redundant.
//
// Both halves matter. agent comes from the process chain, tool from ProcExe /
// ProcCmd, and a great many real actors are named ONLY in the second — an MCP
// server runs as uv or node, and claude-code's worker threads surface as
// "Bun Pool 0" or "fs.watch". Reading agent alone showed those as
// unattributed while the record named them outright.
//
// The em dash is for the remainder: neither column identifies anyone. That is
// not a failed lookup, it is the absence of an actor to find — the write is in
// scope through the ruleset's IDE PATH escape rather than because an agent
// acted. Printing a bare process name under a column headed Agent would assert
// the opposite, and would be most wrong for the case the escape exists to
// catch: a binary appearing in <ide>/extensions/, flagged precisely because we
// cannot say who put it there.
export function toRow(g: cli.Group, now = Date.now(), end?: string): Row {
  // An MCP server names itself in ProcCmd, so it arrives as a tool with no
  // agent. "mcp" is a truthful actor for it — the write came from an MCP
  // server, which is a class AIM watches — and it is far more use than a dash.
  const agent = cli.actorOf(g) ?? "";
  // A specific glyph stands in for the name — "claude" is six characters that
  // the mark says in one. The generic mark cannot: it would make aider and
  // cline identical, so those keep their name and wear the generic mark too.
  const own = agent ? cli.actorIcon(agent) : null;
  const chain: string[] = [];
  if (agent && !own && agent !== g.process) {
    chain.push(agent);
  }
  // ONE entry for the process that wrote the file — the same rule as toolsOf
  // in the CLI's digest.go. The tool marker is never a hop: the CLI takes it
  // from the writing process's OWN executable or command line, never from an
  // ancestor, so it labels the process instead of standing before it
  // ("uv:awslabs.aws-documentation-mcp-server", "node:chrome-devtools-mcp").
  // The program before the colon is the interpreter of an interpreter process,
  // else the process. Until 2026-10-03 the chain read "marker › process", the
  // server seemingly calling node or uv. An interpreter running the agent
  // itself ("node:pi" under pi) is the agent writing: nothing after the agent.
  const colon = g.process.indexOf(":");
  const interp = colon > 0 ? g.process.slice(0, colon) : "";
  const script = colon > 0 ? g.process.slice(colon + 1) : "";
  const agentWriting = script !== "" && (script === agent || script === g.agent);
  if (!agentWriting) {
    if (g.tool && g.tool !== g.process && !cli.toolIsRedundant(g.tool, g)) {
      chain.push(`${colon > 0 ? interp : g.process}:${g.tool}`);
    } else {
      // Drop the process when the glyph already IS it. claude writing its own
      // file used to render "claude"; with a mark in front that became
      // "<glyph> claude", saying the same thing twice. The bare glyph is enough.
      const processIsTheMark = own !== null && g.process === agent;
      // Drop a bare version number only when something else already names the
      // actor, so a row can never render empty.
      if (!processIsTheMark && !(cli.processIsUninformative(g.process) && chain.length > 0)) {
        chain.push(g.process);
      }
    }
  }
  return {
    group: g,
    severity: g.risk_severity && cli.SEVERITY_COLOR[g.risk_severity] ? g.risk_severity : "LOW",
    category: (g.risk_category || "OTHER").replace(/_/g, " "),
    description: g.risk_description ?? "",
    mark: agent ? own ?? cli.GENERIC_ACTOR_ICON : null,
    agent,
    // Test the FIELDS, not the rendered chain. When the agent IS the process —
    // claude writing its own file — the chain goes empty, and reading that as
    // "unattributed" rendered the best-attributed row on the host as the
    // worst. This exact regression was introduced twice.
    unattributed: !agent && !g.tool,
    chain,
    pattern: g.file_pattern ?? "",
    logs: g.count,
    seen: seen(g, end),
    last: clock(g.last_seen, g.last_seen, end),
  };
}
