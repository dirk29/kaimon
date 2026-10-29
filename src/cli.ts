// Bridge to the kaimon CLI.
//
// The extension shells out rather than reading the sink itself, and that is a
// deliberate layering choice, not laziness. The sink is root-owned hive-
// partitioned gzipped JSONL evaluated against a compiled-in ruleset;
// reimplementing any of that in TypeScript would mean two rule engines that
// drift. The CLI is also the thing under test, so what the panel shows is what
// `kaimon aim report` shows.

import { execFile } from "child_process";
import { existsSync } from "fs";
import { release } from "os";
import { promisify } from "util";
import * as vscode from "vscode";

const run = promisify(execFile);

// Keep in step with apps/cli/internal/digest/digest.go. Only the fields the two
// surfaces actually read are declared: the CLI emits more, and an interface
// that mirrored all of it would need editing every time the digest grows.
export interface SeverityCount {
  name: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  count: number;
}

export interface Count {
  name: string;
  count: number;
}

// One real path behind a group's pattern, with its own seen span. Field names
// verified against the digest's FileSeen JSON tags.
// Event kinds recorded for a file. Field names verified against the digest's
// FileEvents JSON tags.
export interface FileEvents {
  create: number;
  modify: number;
  attrib: number;
  move: number;
  delete: number;
  write: number;
}

export interface FileSeen extends Count {
  first_seen?: string;
  last_seen?: string;
  file_events?: FileEvents;
  // Net change of the file's size in bytes, summed over its logs; negative
  // when it shrank. Absent when no log measured one (a save through a temp
  // file and a rename) and from a CLI older than it. See digest.FileSeen.
  file_size_change?: number;
  // Timeline slots this file had changes in; see Group.slots.
  slots?: number[];
}

// The CLI's AIM JSON, schema kaimon/2 (2026-10-02): risk_* names, `count` for the
// "#", `agent` as the page shows it ("mcp" for an MCP server acting alone).
export interface Group {
  risk_severity?: string;
  risk_category?: string;
  // The rule's description, for the badge tooltip.
  risk_description?: string;
  agent?: string;
  // The tool the agent acted THROUGH, and a separate field from agent because
  // digest.AgentIn sources them from different columns: agent from Process /
  // ProcAncestry / ProcParent, tool from ProcExe / ProcCmd. An MCP server or a
  // claude-code worker thread is named only in ProcCmd, so it arrives as a
  // tool with NO agent — 9 of 63 groups on 2026-09-19. Reading agent alone
  // rendered those as unattributed when the record names them outright.
  tool?: string;
  process: string;
  user: string;
  // Rank of the matched rule WITHIN its severity tier. It restarts at 1 in
  // every tier, so it only means anything after severity has been compared,
  // and 0 (or absent) means unranked and sorts last. Mirrors digest.Group.
  risk_priority?: number;
  files: number;
  count: number;
  common_path: string;
  // Bash-style glob summarizing WHAT the group wrote: "index.lock",
  // "*.{go,md}", "{main,ptest_main}.go" or "{gid_map,uid_map,*}". Computed in
  // the digest, where every member of the group is visible and nothing has
  // been capped yet.
  //
  // "*" is glob syntax — something varies, or there is more than is listed.
  // "~" is display only: a fixed string was cut to fit. A pattern WITHOUT a
  // "~" is a real glob; one with it deliberately is not. See digest.Group.
  file_pattern?: string;
  first_seen: string;
  last_seen: string;
  // Real paths behind file_pattern, most active first, capped by the digest at
  // ten. `files` holds the true total, so a client can always say how many are
  // not shown. Absent when the group has none — the hover ignores this, the
  // panel opens onto it.
  top_files?: FileSeen[];
  // Indices into timeseries of the slots this group had changes in. Anomaly
  // groups only, and absent from a CLI older than them — the rows then simply
  // never light from the timeline.
  slots?: number[];
}

// One timeline slot. The slot's instant is meta.start_time plus its index
// times meta.bucket_seconds; time_slot is the CLI's label, in UTC (the host's
// zone for -since windows until 2026-10-01),
// unused here because the panel labels in the viewer's.
export interface Bucket {
  time_slot: string;
  file_changes_risk: number;
  file_changes: number;
  // file_changes_risk by severity, all four, as the top-level list.
  severity_counts?: SeverityCount[];
}

export interface Report {
  // bucket_seconds is absent from a CLI older than clock-aligned slots; the
  // panel then draws no timeline rather than a wrong one.
  meta: { host: string; start_time: string; end_time: string; bucket_seconds?: number };
  kpi: { agents: number; file_changes: number; files: number; file_changes_risk: number };
  timeseries?: Bucket[];
  severity_counts: SeverityCount[];
  grouped_file_changes_risk?: Group[];
  grouped_file_changes_routine: Group[];
  // Total BEFORE the -top cap, so the hover can say "and N more" honestly.
  grouped_file_changes_risk_total: number;
}

// A setup problem one command fixes: shown instead of an empty or quiet view
// (local.md 2.4.2, "keep missing CLI, stopped daemon, inaccessible sink and
// unsupported runtime actionable"). A state no command on this host fixes, a
// cloud host, has no label or command and says so in its note.
export interface Setup {
  title: string;
  label?: string;
  command?: string;
  note?: string;
}

export const INSTALL_COMMAND = "curl -fsSL https://kaimon.co/install | sudo sh";

export const NOT_INSTALLED: Setup = {
  title: "The kaimon daemon is not installed on this host.",
  label: "Install",
  command: INSTALL_COMMAND,
  note: "Records local file changes only. Nothing leaves this machine.",
};

export const NOT_RUNNING: Setup = {
  title: "The kaimon daemon is not running.",
  label: "Start",
  command: "sudo systemctl start kaimond-local",
};

// A daemon that starts and dies: an unsupported kernel, no BTF, a runtime that
// cannot load the BPF objects. Starting it again cannot help; the preflight
// says why.
const CANNOT_START: Setup = {
  title: "kaimon could not start on this host.",
  label: "Check",
  command: "sudo kaimond --check",
};

const LOCAL_OFF: Setup = {
  title: "kaimon is installed, but local collection is off.",
  label: "Turn on",
  command: "sudo kaimon-enable-local",
};

// No local sink because the cloud unit collects: kaimon-enable-local would
// stop its reporting (and refuses to), so there is nothing to offer here.
const CLOUD_HOST: Setup = {
  title: "This host reports to kaimon cloud.",
  note: "Local AIM runs on hosts without cloud collection.",
};

// A VS Code Dev Container runs this extension inside the container, where
// neither the CLI, the sink nor systemd is; the install command cannot work
// there. Dev Containers are not supported in v1 (local.md, Remaining local
// work), so these say only where kaimon runs.
const IN_CONTAINER: Setup = {
  title: "kaimon records on the host, not inside this container.",
  note: "Open this project in a VS Code window on the host to see its report.",
};

// Docker Desktop (Mac, Windows) runs containers in its own Linux VM, whose
// kernel names itself linuxkit: there is no host kaimon could run on.
const DOCKER_DESKTOP: Setup = {
  title: "kaimon needs a Linux host.",
  note: "Docker Desktop's VM cannot run it.",
};

// WSL starts its distributions without systemd unless /etc/wsl.conf turns it
// on (Ubuntu 24.04 and later ship it on), and kaimon runs as a systemd service:
// installing or starting cannot work until it is on. No command: a one-line
// append could add a second [boot] section to a wsl.conf that has one.
const WSL_NO_SYSTEMD: Setup = {
  title: "kaimon needs systemd, which this WSL distribution runs without.",
  note: "Add [boot] systemd=true to /etc/wsl.conf, run wsl --shutdown in Windows, then reopen this window.",
};

function wslWithoutSystemd(): boolean {
  return release().toLowerCase().includes("microsoft") && !existsSync("/run/systemd/system");
}

const SINK_UNREADABLE: Setup = {
  title: "kaimon cannot read its log sink.",
  label: "Fix",
  command: "sudo kaimon-enable-local",
};

export class CliError extends Error {
  constructor(message: string, readonly setup?: Setup) {
    super(message);
  }
}

function config() {
  const c = vscode.workspace.getConfiguration("kaimon");
  return {
    bin: c.get<string>("path", "kaimon"),
    // 1h, not 15m. The window is how long a finding survives in the hover, and
    // 15m retired alerts before anyone looked: measured 2026-09-20, six findings
    // in 24h left a 15m window lit for 90 of 1,440 minutes, so ~19 glances in 20
    // landed on an empty hover after something had happened. Dirk lost track of
    // a real HIGH that way. 1h triples the coverage and costs 0.48s per fetch
    // against 0.22s.
    window: c.get<string>("window", "1h"),
    refreshSeconds: c.get<number>("refreshSeconds", 30),
  };
}

export function currentWindow(): string {
  return config().window;
}

export function refreshSeconds(): number {
  return config().refreshSeconds;
}

async function kaimon(args: string[], maxBuffer: number, timeout = 30_000): Promise<string> {
  const { bin } = config();
  try {
    // The CLI writes advisory notes to stderr (no logs in window, version
    // skew) and still exits 0, so stderr is not an error signal here.
    const { stdout } = await run(bin, args, { maxBuffer, timeout });
    return stdout;
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
    // Killed at the timeout: Node reports only "Command failed: <cmd>" with an
    // empty stderr, which reads like a CLI bug. Seen 2026-09-25 while the host
    // sat at load 10 — the same command ran in 0.3s when quiet, 4.6s under load.
    if (err.killed) {
      throw new CliError(
        `kaimon ${args.slice(0, 2).join(" ")} took longer than ${timeout / 1000}s and was stopped — the host may be busy. The next refresh retries.`,
      );
    }
    if (err.code === "ENOENT") {
      // A custom kaimon.path that points nowhere is a settings mistake, not a
      // missing install.
      if (bin !== "kaimon") {
        throw new CliError(`kaimon CLI not found at "${bin}". Check the kaimon.path setting.`);
      }
      // Docker writes /.dockerenv into every container, Podman /run/.containerenv.
      const setup = !(existsSync("/.dockerenv") || existsSync("/run/.containerenv"))
        ? wslWithoutSystemd() ? WSL_NO_SYSTEMD : NOT_INSTALLED
        : release().includes("linuxkit") ? DOCKER_DESKTOP : IN_CONTAINER;
      throw new CliError(setup.title, setup);
    }
    const msg = (err.stderr || err.message).trim();
    if (msg.includes("no sink at")) {
      const setup = (await unitActive("kaimond")) ? CLOUD_HOST : LOCAL_OFF;
      throw new CliError(setup.title, setup);
    }
    if (/permission denied/i.test(msg)) {
      throw new CliError(SINK_UNREADABLE.title, SINK_UNREADABLE);
    }
    throw new CliError(msg);
  }
}

// -top 100 rather than the CLI's default 20.
//
// The status bar counts findings, and findings are GROUPS. At the default cap
// the group list is truncated at 20 and the count would silently understate on
// a busy window. 100 is far above any window that is still worth showing at a
// glance, and the cost is nil — a 15m window renders in ~0.16s either way.
// The windows the panel offers. Local AIM answers "what did my agents just
// do" — at most the last day; history beyond that is the cloud product, and
// the local sink keeps two days (kaimond-local.service, keep:2d). "1d" is
// passed as 24h because the CLI's -since is a Go duration, which has no "d".
//
// Labels are words, read after "Last": "Last 10 min", "Last 1 hour", "Last 1
// day" — the familiar form (Dirk, 2026-09-25). "Last 1 hour" is the one the
// hover shows, and its header line still fits on one line with three agents.
//
// every: how often, in seconds, an open panel on that window re-runs its
// report, when not on every poll. A day of 1.6M file changes took 10-25s to
// scan on ubu26 (2026-10-12), so a 30s poll kept the 1 day view rescanning
// nearly back to back (Dirk: every 5 min).
export const WINDOWS: { label: string; since: string; every?: number }[] = [
  { label: "10 min", since: "10m" },
  { label: "1 hour", since: "1h" },
  { label: "1 day", since: "24h", every: 300 },
];

export function windowLabel(since: string): string {
  return WINDOWS.find((w) => w.since === since)?.label ?? since;
}

// Past an hour a run is a scan of up to a day of logs: ~8s on ubu26 when
// quiet (2026-09-26), and a busy host (a deploy, a build) can triple that. At
// the 30s limit such a run was stopped and shown as an error.
function timeoutFor(window: string): number {
  return window === "10m" || window === "1h" ? 30_000 : 120_000;
}

export async function report(window = config().window): Promise<Report> {
  const out = await kaimon(["aim", "report", "-since", window, "-top", "100"], 8 << 20, timeoutFor(window));
  return JSON.parse(out) as Report;
}

// The full HTML report. Measured at 181 KB for a full day, so the buffer is
// sized well above that rather than at it.
// The HTML report for the same window the panel shows. It used to take no
// window at all, which made the CLI report "today in UTC so far" — neither the
// panel's window nor a day in the user's own time zone.
export async function reportHTML(window = config().window): Promise<string> {
  return kaimon(["aim", "report", "-since", window, "-format", "html"], 64 << 20, timeoutFor(window));
}

// The same report as JSON — what the report tab's JSON button saves, with the
// HTML's own -top so both files carry the same rows, as the portal's pair does.
export async function reportJSON(window = config().window): Promise<string> {
  return kaimon(["aim", "report", "-since", window], 64 << 20, timeoutFor(window));
}

// Whether a kaimond is actually collecting.
//
// This is what separates "nothing happened" from "the daemon died", and a
// security tool that cannot tell those apart is worse than no tool. Both unit
// names are checked because kaimond-local.service is the local-only mode and
// the two Conflict= so exactly one runs.
export async function daemonActive(): Promise<boolean> {
  return (await unitActive("kaimond")) || (await unitActive("kaimond-local"));
}

async function unitActive(unit: string): Promise<boolean> {
  try {
    const { stdout } = await run("systemctl", ["is-active", unit], { timeout: 5_000 });
    return stdout.trim() === "active";
  } catch {
    // is-active exits non-zero for every state that is not active, which is
    // an answer rather than a failure.
    return false;
  }
}

// Why the local daemon is not collecting: stopped, which a start fixes, or
// failing, which it does not. The unit has Restart=always every 5s, too slow
// to trip systemd's start limit, so a daemon that cannot run sits in
// auto-restart forever rather than reaching "failed".
export async function daemonDown(): Promise<Setup> {
  if (wslWithoutSystemd()) {
    return WSL_NO_SYSTEMD;
  }
  try {
    const { stdout } = await run("systemctl", ["show", "kaimond-local", "-p", "ActiveState", "-p", "SubState"], { timeout: 5_000 });
    if (/^ActiveState=failed$/m.test(stdout) || /^SubState=auto-restart$/m.test(stdout)) {
      return CANNOT_START;
    }
  } catch {
    // No systemd answer: fall back to the plain start, as before.
  }
  return NOT_RUNNING;
}

export function severity(r: Report, name: string): number {
  return r.severity_counts.find((s) => s.name === name)?.count ?? 0;
}

// The severity palette, taken from the report's own stylesheet
// (apps/cli/internal/render/report.css) so the two surfaces cannot drift.
export const SEVERITY_COLOR: Record<string, string> = {
  CRITICAL: "#dc2626",
  HIGH: "#ea580c",
  MEDIUM: "#eab308",
  // #94a3b8 rather than the report's #475569. The report is a white page where
  // dark slate recedes correctly; the hover is dark, where the same value was
  // nearly unreadable. This is a lighter slate that still recedes against both.
  LOW: "#94a3b8",
};

// A severity with no findings keeps its HUE and loses its intensity.
//
// The report dims its equivalent with opacity: 0.4, which is not available
// here — opacity is the same class of style property as background-color, and
// that one is dropped by the tooltip sanitizer. So the dimming is baked into
// the color: each channel is averaged with mid gray, which halves saturation
// while leaving the hue recognizable. A flat gray was tried first and was
// wrong — it made a zero CRITICAL indistinguishable from a zero LOW.
// Dimmed variants, for a severity with no findings.
//
// A TABLE, not a formula. One blend ratio cannot serve all four: red is dark
// to begin with, so a mix strong enough to visibly dim yellow turns red into
// gray-brown, and a mix gentle enough to keep red red leaves yellow looking
// live. Measured by eye on 2026-09-19 against a dark tooltip, after 0.5 failed
// on MEDIUM and 0.65 failed on CRITICAL.
//
// opacity would have avoided all of this by dimming without touching hue, and
// it is not available: the tooltip sanitizer discards the entire style
// attribute when it contains any property other than color, so the zeros came
// out white rather than faded.
export const SEVERITY_DIM: Record<string, string> = {
  CRITICAL: "#a33e3e",
  HIGH: "#96522a",
  MEDIUM: "#7d6a2b",
  LOW: "#616a76",
};

// The timeline's line and dot colors. In the dark theme the same as
// SEVERITY_COLOR; in the light theme the report's accents, so MEDIUM stays
// yellow in the chart while its text turns dark bronze.
export const SEVERITY_LINE: Record<string, string> = { ...SEVERITY_COLOR };

export const COUNTED: readonly string[] = ["CRITICAL", "HIGH", "MEDIUM"];

// The findings a person would act on.
//
// GROUPS, not records. severity_counts counts individual log records, and on
// 2026-09-19 that read 6 while the panel listed 3 rows — both right, counting
// different units, which a user resolves by concluding the tool is broken. A
// finding is the thing you act on, so the status bar counts what the panel
// lists.
//
// MEDIUM is INCLUDED, reversing the call in the plan's "two surfaces" section.
// That call was argued from record counts — "an ordinary day carried 84 of
// them" — and grouping changes the number it rests on. Measured 2026-09-18:
// 118 HIGH records collapse to 2 groups and 9 MEDIUM records to 2, so counting
// MEDIUM moves the busiest available day from 2 to 4. The lit-counter risk the
// exclusion existed to prevent is not there at group granularity.
//
// LOW is still excluded, and by the same measurement: 46 groups that day. That
// one WOULD stay permanently lit.
// grouped_file_changes_risk is OMITTED, not empty, when a window has no activity at
// all — the Go side tags it omitempty. Every reader must go through this or a
// genuinely quiet minute throws "Cannot read properties of undefined".
// Observed 2026-09-20 with a 1m window.
export function groups(r: Report): Group[] {
  return r.grouped_file_changes_risk ?? [];
}

// The status bar's number: CHANGES at CRITICAL, HIGH and MEDIUM — the sum of
// those three boxes of the strip, so clicking through shows the same number.
// It counted rows until 2026-09-25; changes say how much happened in the same
// space ("AIM 2" for two rows of 4 changes hid half of it).
export function needsReview(r: Report): number {
  const c = severityCounts(r);
  return COUNTED.reduce((a, k) => a + c[k], 0);
}

// Logs per severity, the report's severity_counts: the dashboard's severity
// boxes count LOGS and add up to Anomalies Detected, so the strip does too.
// It counted rows until 2026-09-25, which put "LOW 13" beside a header and a
// timeline that said 798.
export function severityCounts(r: Report): Record<string, number> {
  const out: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const c of r.severity_counts ?? []) {
    if (Object.prototype.hasOwnProperty.call(out, c.name)) {
      out[c.name] = c.count;
    }
  }
  return out;
}

// The worst severity present, for coloring a single indicator.
export function worstSeverity(r: Report): string | undefined {
  const c = severityCounts(r);
  return COUNTED.find((k) => c[k] > 0);
}

// The actors named in this window, derived the SAME way the table's Agent
// column derives them — otherwise the header lists a different set of names
// than the rows below it, which is how "mcp" went missing from the summary
// while appearing on two rows.
// Tools that ARE an agent under another name, not a tool the agent used.
//
// digest.AgentIn already treats this pair as one actor — it drops a tool that
// restates the agent, noting "claude(-code)? ... one actor, rendered twice".
// That dedup only fires when the process chain resolved the agent. When the
// command line was the ONLY evidence, the same actor arrives as a bare tool
// with no agent, and without this map it counts as neither: absent from the
// header while its rows sit in the table. In a window where claude worked only
// through paths the chain could not resolve, the header would have read "No
// activity attributed to any agent" above a table full of claude-code rows.
const TOOL_IS_AGENT: Record<string, string> = {
  "claude-code": "claude",
};

export function actorOf(g: Group): string | undefined {
  if (g.agent) {
    return g.agent;
  }
  if (g.tool && TOOL_IS_AGENT[g.tool]) {
    return TOOL_IS_AGENT[g.tool];
  }
  return g.tool && /mcp/i.test(g.tool) ? "mcp" : undefined;
}

// Actor marks, contributed as an icon font in package.json and rendered with
// $(name) wherever a ThemeIcon is accepted — the status bar and, because
// supportThemeIcons is set, the hover as well.
//
// Only actors with their OWN glyph are returned here. Everything else falls
// back to the generic mark AND keeps its name, because one shared robot for
// aider, cline, windsurf and goose would erase the distinction the column
// exists to make. A specific glyph replaces the name; the generic one
// accompanies it.
const ACTOR_ICONS: Record<string, string> = {
  claude: "kaimon-claude",
  codex: "kaimon-codex",
  gemini: "kaimon-gemini",
  cursor: "kaimon-cursor",
  mcp: "kaimon-mcp",
  copilot: "kaimon-copilot",
  opencode: "kaimon-opencode",
  junie: "kaimon-junie",
  antigravity: "kaimon-antigravity",
  pi: "kaimon-pi",
  cline: "kaimon-cline",
  kilo: "kaimon-kilo",
};

export const GENERIC_ACTOR_ICON = "robot";

// Brand-ish color per actor mark. This works at all only because the marks
// are FONT GLYPHS, not images: "color" is the one property the hover
// sanitizer does not strip, and it applies to a glyph exactly as it would to
// text.
//
// Chosen to sit clear of the severity scale, which owns red/orange/yellow and
// is the color meaning that matters most. Codex takes its green and Gemini
// its blue for that reason. Claude's terracotta is the one close call — it
// neighbors HIGH (#ea580c) — but it is markedly softer and it is the actual
// brand value, so it stays unless it reads as a severity on screen.
export const ACTOR_COLOR: Record<string, string> = {
  // Taken from Anthropic's own claude-logo.svg, which fills with #D97757.
  "kaimon-claude": "#d97757",
  // Neutral, not the old OpenAI green. The glyph is now their official mark,
  // which is monochrome — recoloring a vendor's actual artwork is the thing
  // brand guidelines do prohibit, where merely displaying it is normal. A
  // mid-gray also survives both a light and a dark hover.
  "kaimon-codex": "#9ca3af",
  "kaimon-gemini": "#4796e3",
  "kaimon-cursor": "#a1a1aa",
  // MCP's official mark is monochrome, but unlike the vendor logos it is MIT
  // licensed AND below the threshold of originality, and MIT grants the right
  // to modify. Recoloring it is permitted where recoloring the OpenAI mark
  // is not, so it takes a hue that stays clear of the severity scale.
  "kaimon-mcp": "#a78bfa",
  // Official marks shown in one neutral, like codex: each is the vendor's own
  // artwork (provenance in assets/build-font.js), and a neutral is the only
  // recoloring that is not a change to it. Junie keeps its own brand green,
  // as Claude keeps its orange: the vendor's color, unmodified.
  // Copilot's official mark is monochrome and GitHub gives it no color of its
  // own (the mint once used here appears nowhere on GitHub's Copilot pages).
  "kaimon-copilot": "#9ca3af",
  "kaimon-opencode": "#9ca3af",
  "kaimon-cline": "#9ca3af",
  "kaimon-kilo": "#9ca3af",
  "kaimon-junie": "#48e054",
  // Google's brand blue, the base of Antigravity's own gradient arch: a color
  // taken from the vendor's artwork, since a font glyph cannot show the gradient.
  "kaimon-antigravity": "#4285f4",
  // The salmon block of Pi's own logo (pi.dev/logo-auto.svg); its yellow is too
  // close to MEDIUM and its blue would be the fourth blue.
  "kaimon-pi": "#f09082",
  // The generic mark deliberately recedes: it carries no identity, and the
  // name beside it is doing the work.
  robot: "#94a3b8",
};

// The light theme: the dark theme's severity colors, with MEDIUM and LOW one
// shade darker so they read on white (the dark theme's yellow and slate are
// too pale there). The report's dark text shades were used until 2026-10-29:
// they suit its tinted badges, but as bare text CRITICAL, HIGH and MEDIUM all
// read as the same brown. Marks keep their own color where it reads on white;
// greens and the pale ones get a darker shade of the same hue.
const LIGHT = {
  sev: { CRITICAL: "#dc2626", HIGH: "#ea580c", MEDIUM: "#ca8a04", LOW: "#64748b" },
  dim: { CRITICAL: "#cc8d8d", HIGH: "#cc9a88", MEDIUM: "#c2a686", LOW: "#99a0aa" },
  line: { CRITICAL: "#dc2626", HIGH: "#ea580c", MEDIUM: "#ca8a04", LOW: "#64748b" },
  actor: {
    "kaimon-codex": "#6b7280",
    "kaimon-gemini": "#1a73e8",
    "kaimon-cursor": "#71717a",
    "kaimon-mcp": "#7c3aed",
    "kaimon-copilot": "#6b7280",
    "kaimon-opencode": "#6b7280",
    "kaimon-cline": "#6b7280",
    "kaimon-kilo": "#6b7280",
    "kaimon-junie": "#178a30",
    "kaimon-pi": "#c95a4b",
    robot: "#64748b",
  } as Record<string, string>,
};

const DARK = {
  sev: { ...SEVERITY_COLOR },
  dim: { ...SEVERITY_DIM },
  line: { ...SEVERITY_LINE },
  actor: { ...ACTOR_COLOR },
};

// Swaps the tables in place, so every reader of SEVERITY_COLOR and the rest
// sees the theme's values on its next render. The caller redraws.
export function applyTheme(kind: vscode.ColorThemeKind): void {
  const light = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight;
  const t = light ? LIGHT : DARK;
  Object.assign(SEVERITY_COLOR, t.sev);
  Object.assign(SEVERITY_DIM, t.dim);
  Object.assign(SEVERITY_LINE, t.line);
  Object.assign(ACTOR_COLOR, DARK.actor, light ? LIGHT.actor : {});
}

/** The actor's own glyph, or null when it only rates the generic mark. */
export function actorIcon(actor: string): string | null {
  return ACTOR_ICONS[actor.toLowerCase().split(/[^a-z0-9]/)[0]] ?? null;
}

export function toolIsAgent(tool: string): boolean {
  return Object.prototype.hasOwnProperty.call(TOOL_IS_AGENT, tool);
}

// Whether the tool adds nothing over the actor already shown.
//
// Two different cases, and conflating them cost the MCP server name:
//
//   real agent from the chain  -> mirror digest.AgentIn's substring test, so
//                                 "claude" + "claude-code" collapses to one.
//   actor DERIVED from the tool -> only an exact TOOL_IS_AGENT match is
//                                 redundant. The generic "mcp" fallback is a
//                                 CLASS, not a name, so the tool still carries
//                                 the only identifying information there:
//                                 dropping it turned
//                                 "mcp > mcp-proxy-for-aws > uv" into
//                                 "mcp > uv", which names no server at all.
export function toolIsRedundant(tool: string, g: Group): boolean {
  // "mcp" is the actor for an MCP server acting alone, so every MCP tool name
  // contains it; the tool is the information there, never a repeat.
  if (g.agent === "mcp") {
    return false;
  }
  if (g.agent) {
    return tool.includes(g.agent) || g.agent.includes(tool);
  }
  return toolIsAgent(tool);
}

// claude installs its binary as ~/.local/share/claude/versions/<version>, so
// the kernel's comm for that process is literally "2.1.197" and the row reads
// "claude > 2.1.197". That is truthful and useless: it names a release, not an
// actor, and a developer reading the hover cannot act on it. Observed on ubu26
// 2026-09-20 across 3 of 22 groups.
//
// This is about the PROCESS NAME being uninformative, not about claude. Any
// agent that execs a version-named binary hits it.
export function processIsUninformative(process: string): boolean {
  return /^v?\d+(\.\d+)+$/.test(process);
}

// Every agent that changed anything, flagged or routine: an hour whose only
// change was routine still names who made it ("Claude raised risk findings for
// 0 file changes out of 1 total"), where flagged groups alone left the line saying no
// agent was active beside a timeline that showed a change.
export function agentNames(r: Report): string[] {
  const seen = new Set<string>();
  for (const g of [...groups(r), ...(r.grouped_file_changes_routine ?? [])]) {
    const a = actorOf(g);
    if (a) {
      seen.add(a);
    }
  }
  return [...seen].sort();
}
