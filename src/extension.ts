// kaimon — Agent Integrity Monitor.
//
// Activation is onStartupFinished, not workspaceContains: what the daemon
// records is host-wide, so it is worth showing whether or not the open folder
// happens to match a pattern — and with no folder open at all.
//
// extensionKind is "workspace" (package.json): the CLI, the sink and the
// daemon all live on the remote, so the extension has to run there too.

import * as vscode from "vscode";
import * as cli from "./cli";
import * as panel from "./panel";
import * as row from "./row";

// ONE status bar item, and the color covers all of it.
//
// This was briefly two items — a plain "kaimon" label beside a colored count —
// because StatusBarItem.color applies to the whole item and splitting is the
// only way to color just the number. VS Code pads every item, so the pair
// rendered with a visible gap between the word and the digit and read as two
// separate widgets. There is no API to close that gap.
//
// So the two goals are mutually exclusive, and contiguity won: a severity
// color on "$(shield) kaimon 5" is still unambiguous, whereas a broken-up
// widget looks wrong at every severity including quiet.
let item: vscode.StatusBarItem;
let timer: NodeJS.Timeout | undefined;

// NO SECOND TIMER. The tooltip is a snapshot, set when the data is fetched and
// left alone until the next fetch.
//
// A 5-second re-render was tried on 2026-09-19 so that a relative "Updated 12s
// ago" would keep counting. Assigning item.tooltip re-renders an OPEN hover, so
// the effect was a flash every five seconds that changed one number and nothing
// else — motion with no information, while the reader is mid-sentence. The age
// is now an absolute clock time, which is correct whenever it is read and needs
// no timer to stay correct.
// down: why it is not collecting, when it is not.
let last: { r: cli.Report; collecting: boolean; at: number; down?: cli.Setup } | undefined;


// Escape only what breaks a markdown TABLE CELL: the column separator and the
// escape character itself. A general markdown escaper is wrong here — escaping
// "." rendered a process as "python3\\.14", backslash and all.
// When the data behind the hover was read, as a clock time.
//
// Absolute, not relative, and that is the whole point: "12s ago" is only true
// at the instant it is rendered and needs a repaint every few seconds to stay
// true, whereas a timestamp is still correct an hour later. The reader can see
// their own clock.


// The glyph for an actor, as a $(name) token with a trailing space, or "" if
// there is no actor. Always returns a mark: a specific one where we have it,
// the generic agent otherwise.
// The actor's mark, colored, with the chain separator already attached. A
// caller that has nothing to join trims it.
function actorMark(a: string): string {
  const id = cli.actorIcon(a) ?? cli.GENERIC_ACTOR_ICON;
  return `${color(`$(${id})`, cli.ACTOR_COLOR[id])} \u203a `;
}

// Cell content goes into an HTML table now, so it is HTML-escaped, not
// markdown-escaped. md() turns "*" into "\\*", which renders as a literal
// backslash inside a <td>, and markdown emphasis is not processed there
// either — hence <b>/<i> below rather than ** and _.
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function md(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    // Asterisks too, since file patterns arrived: "*.{json,sh,*}" has a PAIR
    // of them, which markdown read as emphasis — it rendered the middle in
    // italics and swallowed both asterisks, leaving ".{json,sh,}". Single-
    // asterisk globs like "*.lock" looked fine because nothing closed them,
    // which is what made it look like a data bug rather than a markup one.
    .replace(/\*/g, "\\*");
}

// Inline color in a markdown tooltip.
//
// Markdown has no color, so this needs supportHtml. That is not a guess: the
// claude-code-usage extension installed on this host ships a status bar tooltip
// using <span style="background-color:..."> with supportHtml = true, so the
// sanitizer permits style on a span.
// Column geometry, in pixels. These are the ONLY numbers that decide the
// table's shape now — no character padding, no proportional-font guesswork.
// Both tables are TABLE_W wide, so their right edges line up by construction
// rather than by tuning.
// 480 because the hover is capped at 500. From VS Code's hoverWidget.css:
//   .monaco-hover .markdown-hover > .hover-contents {
//       max-width: var(--vscode-hover-maxWidth, 500px); }
//   .monaco-hover .hover-contents { padding: 4px 8px; }
//   .monaco-hover { box-sizing: border-box; }
// so the usable width is 500 - 16 = 484. A table wider than that is CLIPPED,
// not shrunk — 560 lost the whole Seen column off the right edge.
//
// Note the cap is a CSS variable, so a user who sets --vscode-hover-maxWidth
// gets more room; 480 is sized for the default and simply leaves space on a
// wider setting.
const TABLE_W = 480;
const COL_W = TABLE_W / 4;               // four severities, 120 each, sums exactly
// Detail table: Risk, Agent > Files, #, Seen. Sums to TABLE_W.
// 108: the widest COMMON label is SANDBOX SETUP at ~104px.
// Rarer, longer ones (AGENT CREDENTIAL, CREDENTIAL WRITE) widen the column
// only on the hovers where they appear — labels use non-breaking spaces, so
// the table grows the column rather than wrapping the name. It was 115 while
// DEPENDENCY CHANGE (~140px, now PROJECT EDIT) was a common row.
const D_RISK_W = 108;
const D_NUM_W = 32;
// 64: the hover's Seen is the most recent end alone ("10:59pm", ~52px). The
// range ("3:28 \u2192 4:25pm") is the panel's: the hover is the glance, and "how
// recent?" is the glance question; "since when?" is detail (Dirk,
// 2026-09-25). The hover cannot grow instead: VS Code caps it at 500px
// (above). The range needed 100, so Agent gained 36px. Headed "Seen" like the
// panel; "Last Seen" was tried and cost width for a word the glance implies.
const D_SEEN_W = 64;
const D_AGENT_W = TABLE_W - D_RISK_W - D_NUM_W - D_SEEN_W;



// NO SPACER PARAGRAPH around the rules. One was tried on 2026-09-19 and
// removed: markdown offers nothing between "no gap" and "a whole empty
// paragraph", and the paragraph stacked on top of the following table's own
// margin, so the space under each rule came out far larger than the space
// above it. Letting the default block margins do it keeps the two sides equal.

// ONLY "color" may appear in this style attribute.
//
// The tooltip sanitizer drops the WHOLE style attribute when it contains a
// single unsupported property — it does not strip the offender and keep the
// rest. Proven on 2026-09-19 by adding opacity for the zero severities: the
// zeros did not fade, they turned WHITE, having lost their color along with
// the opacity.
//
// That one behavior explains every earlier failure here. The report's filled
// badge (background-color + color + border-radius) rendered as plain text, and
// the category note with font-size rendered full size — in both cases the
// color vanished too, which at the time looked like two separate properties
// being unsupported. It was one rule.
//
// So: dimming cannot use opacity, and hue-preserving dimming is not available.
// cli.dim() bakes the fade into the color value itself, which is the only
// lever that survives.
function color(text: string, hex: string): string {
  return `<span style="color:${hex};">${text}</span>`;
}

// The risk cell: the category name, tinted by severity.
//
// A second line under the name — the category's meaning in a few words, via
// <br> and a smaller span — was tried on 2026-09-19 and removed. font-size
// does not survive the tooltip sanitizer here, so the note rendered at full
// size and competed with the risk name it was meant to annotate. The same
// sanitizer drops background-color, which is why the report's filled badge is
// not used either; "color" is the one style property confirmed to work.
//
// If this is revisited, the constraint to design around is that everything in
// a hover renders at one size.
function categoryCell(x: row.Row): string {
  // Non-breaking spaces: the category is a label, not prose, and
  // "DEPENDENCY CHANGE" wrapping to two lines dragged the whole row with it.
  const name = esc(x.category.replace(/ /g, "\u00a0"));
  return color(`<b>${name}</b>`, cli.SEVERITY_COLOR[x.severity]);
}


// The Agent \u203a Tools \u203a Files cell, drawn from a row. WHAT goes in it —
// which actor, which links of the chain, when to show a dash — is decided in
// row.ts and shared with the panel. Only the drawing lives here: the codicon
// mark, the colors, the escaping and the break hints.
function agentCell(x: row.Row): string {
  const lead = x.unattributed
    ? color("\u2014", cli.SEVERITY_COLOR.LOW)
    : x.mark
      ? color(`$(${x.mark})`, cli.ACTOR_COLOR[x.mark])
      : "";
  // The file pattern is ALWAYS last and always present, so the column has a
  // fixed shape: actor, then how, then what. A reader learns that the tail is
  // the file, which is why a bare "*" is shown rather than omitted — an
  // absent element would break the shape it exists to teach.
  //
  // A comma is the seam in a brace list, but CSS does not treat it as a break
  // opportunity — so "{gid_map,setgroups,uid_map,core,fd,*}" had NO legal
  // break anywhere, and "{.codex-remo~,0cab3b4286b2152e}.json" could only
  // break at its one early hyphen, stranding "{.codex-" on a line of its own.
  // A zero-width space after each comma gives the renderer a seam at every
  // item, and it picks the last one that fits. Inserted here rather than in
  // the CLI: file_pattern stays a glob that can be pasted into a shell, and
  // only the rendering carries the hints.
  //
  // A display:inline-block span was tried here on 2026-09-22 to make the
  // pattern an atomic unit — so a cell that does not fit would break BETWEEN
  // the chain and the pattern instead of inside a file name. It rendered
  // BORDERS on every cell of both tables and did not stop the internal break,
  // so the sanitizer does not treat that property the way color is treated.
  // Do not retry without checking what the hover actually renders.
  //
  // Italic, so the file shape reads as a different KIND of thing from the
  // actors before it — it answers "what", the rest answers "who".
  const tail = x.pattern
    ? "<i>" + esc(x.pattern).replace(/,/g, ",\u200b") + "</i>"
    : "";
  // The mark joins the chain with a chevron like any other link, because it
  // IS a link in it — the column is headed Agent, and "<mark> gnucp" read as
  // a labeled process rather than "this agent, acting through gnucp".
  //
  // NOT wrapped here. This ran wrapAtDash, which counted CHARACTERS against
  // a budget while the table sizes its columns in PIXELS. The two agreed
  // only at one font size, so the hover wrapped differently on a machine
  // with a different editor font. The cell wraps itself now: " \u203a "
  // carries spaces, which CSS already treats as the best break, then hyphens,
  // and the pattern gets its own seams from the zero-width spaces above.
  return [...(lead ? [lead] : []), ...x.chain.map(esc), ...(tail ? [tail] : [])].join(" \u203a ");
}
// The hover.
//
// A single sentence could not carry what a glance needs, so this is a table:
// every anomaly group in the window, worst first, LOW included. LOW is left out
// of the COUNT but belongs here — it is the texture that shows the machine is
// being watched, and without it a quiet hover looks like a broken one.
export function tooltip(r: cli.Report, collecting: boolean, at: number): vscode.MarkdownString {
  const s = row.summary(r, collecting);
  const who = s.agents;

  // One context line, no separate verdict.
  //
  // "N findings need review" had its own line above this one and was dropped
  // 2026-09-19: the count is already the status bar's whole job, and the
  // severity table directly below breaks the same number down. Three
  // statements of one figure, stacked.
  //
  // "Not collecting" is NOT folded away with it. It is the one thing this
  // hover says that no other surface does, and a quiet window and a dead
  // daemon are indistinguishable without it — so it leads the line, in bold.
  const bits: string[] = [];
  if (!collecting) {
    bits.push("<b>Not collecting</b>");
  }
  bits.push(
    who.length
      ? row.changesBy(who.map((a) => `${actorMark(a).replace(/\u203a $/, "")}<b>${esc(row.agentLabel(a))}</b>`).join(", "), s.logs, s.flagged, false)
      : "No activity attributed to any agent",
  );
  const lines = [
    // The mark leads the title, the same glyph the status bar wears, so the
    // hover is visibly the same thing the user clicked. Outside the bold
    // markers: an icon has no weight to take.
    //
    // UNCOLORED, so it takes the hover's own foreground. Brand blue was
    // tried and dropped: hardcoding a color is wrong in a light theme, and
    // the two brand values are unusable here anyway — red (#C52720) sits on
    // top of CRITICAL (#dc2626), and both fail the 3:1 contrast a UI glyph
    // wants on this background.
    "$(kaimon-eye) **kaimon \u2014 Agent Integrity Monitor (AIM)**",
    "",
    // The window leads the line, as in the panel ("Last 1h Agents …"): it scopes
    // every number that follows. It used to sit in the footer, away from them.
    // "Last" is plain and the value bold — the same as the panel, where the value
    // is the dropdown. Bold otherwise marks only the agent names.
    //
    // In a one-cell table of TABLE_W, so a line that wraps wraps at the
    // tables' width. As a paragraph it filled the hover's own cap, which is
    // wider than the tables on some builds (Antigravity), and once three agents
    // and "raised" made it wrap (2026-10-01) the hover grew a blank band
    // beside both tables. HTML, not markdown, inside the cell (see esc).
    `<table width="${TABLE_W}"><tr><td>Last <b>${esc(cli.windowLabel(cli.currentWindow()))}</b> ${bits.join(" \u00b7 ")}</td></tr></table>`,
    "",
  ];

  // A zero column keeps its place — the four severities are a fixed scale and
  // dropping one would move the others — but it recedes, so the eye lands on
  // the severities that actually have something in them.
  const sum = s.tiers.map((t) => ({ k: t.k, n: t.n, c: t.color }));
  // Pad every label to the SAME width before the fixed gutter. A markdown
  // column is sized by its content, so CRITICAL(8) HIGH(4) MEDIUM(6) LOW(3)
  // produced four columns of four different widths and the scale read as
  // ragged rather than as one row of four.
  // FINDINGS leads the row: the subtotal first, then the breakdown that makes
  // it up. It is NOT labeled "anomalies" — grouped_file_changes_risk means every
  // group including LOW, which is the 20 the footer reports, so the word is
  // already taken and would contradict the footer on the same screen.
  // Four severities, no FINDINGS subtotal and no divider (2026-09-25). The
  // divider existed only to stop LOW reading as part of the FINDINGS total;
  // with the total gone the four stand as one scale, and the TOP FINDINGS line
  // above the rows names what follows. The status bar still carries the count.
  const cells = sum;
  lines.push("---");
  lines.push("");
  // HTML table, not markdown.
  //
  // VS Code's sanitizer allows the full table element set and the legacy
  // PRESENTATIONAL attributes — width, align, colspan — while permitting only
  // color-ish properties in a style attribute. So <col width> is the one way
  // to state geometry directly, and it replaces every &nbsp; padding constant
  // this file used to carry. The two tables can finally share a width, which
  // markdown could not do because each sized to its own content.
  lines.push(
    `<table width="${TABLE_W}">` +
      cells.map(() => `<col width="${COL_W}">`).join("") +
      // Spacer. The hover's <hr> has margin-top 4px and margin-bottom -4px,
      // so content right under a divider sits 8px tighter than content right
      // over one: the strip hugged the top divider and floated off the
      // bottom one. A cell height is the one vertical size the sanitizer lets
      // through, so this row gives the 8px back: height 4 plus the cell's own
      // 2px top and bottom padding (height="8" measured 12px in the hover).
      `<tr><td colspan="${cells.length}" height="4"></td></tr>` +
      // One row, label and count side by side — the dashboard's severity
      // boxes, minus the boxes: the hover's sanitizer takes a color but no
      // theme-aware background, so the color carries it alone.
      "<tr>" +
      cells
        .map((x) => {
          const v = x.n.toLocaleString();
          const body = color(`<b>${x.k}</b>&nbsp;&nbsp;${x.n === 0 ? v : `<b>${v}</b>`}`, x.c);
          return `<td align="center">${body}</td>`;
        })
        .join("") +
      "</tr></table>",
  );
  lines.push("");
  lines.push("---");
  lines.push("");
  // TOP FINDINGS, as in the panel's bar above its table. The icon says what is
  // under it: a warning in the worst severity's color when there are findings,
  // an info mark in LOW's color when there is only LOW. A codicon, which the
  // hover can draw where the panel needs an inline SVG.
  const mark = s.worst && s.worst.k !== "LOW" ? "$(warning)" : "$(info)";
  lines.push(`${s.worst ? color(mark, s.worst.color) : mark} **TOP FINDINGS**`);
  lines.push("");

  // Order comes from row.ranked, shared with the panel so a row sits in the
  // same place on both surfaces. The reasoning for the order is there.

  // ONE cap over all rows, findings and routine alike.
  //
  // This used to be two buckets — findings up to 12, routine capped at 5 —
  // to stop bookkeeping taking slots that findings should have had. That was
  // redundant: severity is the FIRST sort key, so a finding can never be
  // outranked by a LOW row, and a flat cap gives them the top slots by
  // construction. The split only added a second number to reason about and
  // produced odd totals like "Top 8 of 16" when 10 rows would have fit.
  //
  // It also bounds the height the old unbounded-findings path did not: a day
  // with thirteen findings once rendered an eighteen-row hover.
  //
  // 10, and it stays 10. Raised to 15 on 2026-09-22 and reverted the same day:
  // the hover is a GLANCE, and everything it leaves out is in the panel and
  // the report, so covering a busy hour completely is not what this surface is
  // for. Showing more of the tail only makes the top harder to read.
  //
  // Note this cap counts ROWS while what actually overflows is LINES — a row
  // is one to three of them. In practice 10 rows cost ~13 lines, but the cap
  // cannot promise that. It matters because VS Code CLIPS the hover rather
  // than scrolling it: past the viewport a row is cut through the middle and
  // the footer's "Top 10 of 20" would then overstate what is on screen. A
  // line-budget cap was considered and rejected — it would reintroduce the
  // character-width estimation removed from the wrap logic the day before,
  // and 10 rows is far enough inside the limit that it is not needed.
  const MAX_ROWS = 10;
  const rows = row.ranked(cli.groups(r)).slice(0, MAX_ROWS).map((g) => row.toRow(g, undefined, r.meta.end_time));

  const footer = (shown: number, total: number) =>
    `_${row.footerText(shown, total, r.meta.host, at, md)}_`;

  if (rows.length === 0) {
    lines.push("_No risk findings recorded in this window._");
    lines.push("");
    lines.push(footer(0, 0));
  } else {
    // No path column. It was the only unbounded field, and even middle-truncated
    // it wrapped rows onto a second line, which is what made the table hard to
    // read. Every remaining cell is short enough that a row stays on one line.
    // Category first: the rows are sorted by severity, so the colored column
    // reads as a grouped index down the left edge rather than as decoration on
    // the right.
    //
    // Files and Age are both right-aligned: they are the two numeric columns
    // and a ragged right edge on durations is hard to scan. They are kept
    // apart by their <col width>s — with both hugging their right edge and
    // Age only two or three characters wide, "8" and "1m" otherwise land
    // close enough to read as one value.
    // "Agent \u203a Tools \u203a Files" names the middle slot even though only the
    // two ends are INVARIANT — every row has an actor mark and, by
    // construction, a file pattern. It was "Agent \u203a Files" for exactly that
    // reason, which was sound about the data and poor about the product: the
    // chain is the thing that distinguishes this from a file list, and hiding
    // it in the header hid the column's best feature.
    //
    // Measured over four days, 92% of rows DO carry a middle: 68% a process
    // (bash, sed, python3.14), 24% a tool AND a process
    // (mcp-proxy-for-aws \u203a uv), 8% nothing at all. "Tool" covers both
    // fields deliberately — agent comes from Process/ProcAncestry, tool from
    // ProcExe/ProcCmd, but to a reader they are both "what it acted through".
    //
    // Plural by rule: a header is singular only where the slot ALWAYS holds
    // exactly one. Agent does — the actor is part of the grouping key. Tools
    // holds 0 to 2 and Files 1 to N, so both take the plural. "Tool" was used
    // first on the grounds that 68% of rows show exactly one, which is a
    // different test from the one that made Files plural, and applying it to
    // only one of the two columns is what made the header read as three
    // mismatched words.
    // What sits between them
    // is optional — measured live, some rows are mark/process/file, some are
    // mark/file with no process, one was mark/tool/process/file — so naming a
    // fixed three-part shape would misdescribe most of them.
    //
    // The count column is "#", not "Files": plural in the Agent header and a
    // bare # beside it read as "Files #", where the word in both headers
    // looked doubled. It is also narrower than its own header was.
    //
    // It counts LOG RECORDS, the raw unit and the one the report's Logs
    // column shows — see Row.logs for why not files.
    lines.push(
      `<table width="${TABLE_W}">` +
        `<col width="${D_RISK_W}"><col width="${D_AGENT_W}">` +
        `<col width="${D_NUM_W}"><col width="${D_SEEN_W}">` +
        `<tr><th align="left">Risk</th><th align="left">Agent \u203a Tools \u203a <i>Files</i></th>` +
        `<th align="right">#</th><th align="right">Seen</th></tr>`,
    );
    // valign="top" is an ALLOWED presentational attribute, so the wrapped-cell
    // line padding this used to need is gone: a row whose Agent cell wraps now
    // aligns by attribute instead of by counting <br>s into the other cells.
    for (const x of rows) {
      lines.push(
        `<tr valign="top">` +
          `<td align="left">${categoryCell(x)}</td>` +
          `<td align="left">${agentCell(x)}</td>` +
          `<td align="right">${x.logs}</td>` +
          `<td align="right">${x.last}</td>` +
          `</tr>`,
      );
    }
    lines.push("</table>");
    lines.push("");
    lines.push(footer(rows.length, r.grouped_file_changes_risk_total ?? rows.length));
  }

  const t = new vscode.MarkdownString(lines.join("\n"));
  t.supportThemeIcons = true;
  t.supportHtml = true;
  t.isTrusted = true;
  return t;
}

// One item, three states. The count is CRITICAL + HIGH + MEDIUM groups, and
// when it is zero there is no number at all — a lit counter is one a developer
// stops reading.
//
// No backgroundColor. VS Code offers only statusBarItem.errorBackground and
// warningBackground, both of which paint a solid block across the item and
// force their own contrast foreground, so the severity would be unreadable and
// every non-quiet state would look identical. Coloring the text with the
// report's own palette distinguishes all four and stays quiet.
//
// "off" is not cosmetic. Without it, a quiet window and a dead daemon render
// identically, and a security tool that has silently stopped working looks
// exactly like one with nothing to report.
// The hover for a setup problem: what is wrong, the one command that fixes it
// and a link that copies that command.
function setupTip(st: cli.Setup): vscode.MarkdownString {
  const copy = `command:kaimon.copyCommand?${encodeURIComponent(JSON.stringify([st.command]))}`;
  const tip = new vscode.MarkdownString(
    `**${st.title}**` +
      (st.command ? `\n\n${st.label}: \`${st.command}\` [Copy](${copy})` : "") +
      (st.note ? `\n\n${st.note}` : ""),
  );
  tip.isTrusted = { enabledCommands: ["kaimon.copyCommand"] };
  return tip;
}

// Repaint from the cache. No I/O.
function render(): void {
  if (!last) {
    return;
  }
  const n = cli.needsReview(last.r);
  if (!last.collecting) {
    item.text = "$(kaimon-eye)AIM off";
    item.color = cli.SEVERITY_COLOR.CRITICAL;
  } else if (n > 0) {
    item.text = `$(kaimon-eye)AIM ${n}`;
    item.color = cli.SEVERITY_COLOR[cli.worstSeverity(last.r) ?? "LOW"];
  } else {
    item.text = "$(kaimon-eye)AIM";
    item.color = undefined;
  }
  item.tooltip = last.collecting ? tooltip(last.r, last.collecting, last.at) : setupTip(last.down ?? cli.NOT_RUNNING);
}

async function tick(): Promise<void> {
  try {
    const [r, collecting] = await Promise.all([cli.report(), cli.daemonActive()]);
    last = { r, collecting, at: Date.now(), down: collecting ? undefined : await cli.daemonDown() };
    render();
    panel.update(r, collecting, last.at);
  } catch (e) {
    // A CLI that will not run is the same class of problem as a daemon that is
    // not collecting: the answer is unknown, so do not render it as quiet.
    last = undefined;
    const setup = e instanceof cli.CliError ? e.setup : undefined;
    panel.fail((e as Error).message, setup);
    item.text = "$(kaimon-eye)AIM off";
    item.color = cli.SEVERITY_COLOR.CRITICAL;
    if (setup) {
      item.tooltip = setupTip(setup);
    } else {
      const tip = new vscode.MarkdownString(`$(error) ${(e as Error).message}`);
      tip.supportThemeIcons = true;
      item.tooltip = tip;
    }
  }
}

function reschedule(): void {
  if (timer) {
    clearInterval(timer);
  }
  timer = setInterval(() => void tick(), cli.refreshSeconds() * 1000);
}

export function activate(context: vscode.ExtensionContext): void {
  // Light or dark palette from the active theme, and again on every change:
  // repaint the status bar and hover from the cache and redraw the panel.
  cli.applyTheme(vscode.window.activeColorTheme.kind);
  context.subscriptions.push(
    vscode.window.onDidChangeActiveColorTheme((t) => {
      cli.applyTheme(t.kind);
      render();
      panel.redraw();
    }),
  );
  panel.init(context);
  item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  // $(kaimon-eye) is the kaimon mark, carried in the same contributed icon
  // font as the actor glyphs. It replaced the built-in $(eye) codicon, a
  // generic outline eye that said nothing about whose tool this is.
  //
  // The mark is four colors (#C52720 eye, #006697 brow, #FDF8F7 pupil, white)
  // and a font glyph is monochrome by construction, so only the SHAPE comes
  // across. That is the right trade here: the item already takes the severity
  // color, so a colored mark could not have been used anyway. The brow and
  // eye are merged into one outline; the pupil survives as a hole because it
  // is already a counter-wound subpath. See assets/build-font.js.
  item.text = "$(kaimon-eye)AIM";
  item.command = "kaimon.showActivity";
  item.show();

  context.subscriptions.push(
    item,
    vscode.commands.registerCommand("kaimon.showActivity", () => panel.showActivity()),
    vscode.commands.registerCommand("kaimon.showReport", () => panel.showReport()),
    vscode.commands.registerCommand("kaimon.refresh", () => tick()),
    vscode.commands.registerCommand("kaimon.copyCommand", async (command: string) => {
      await vscode.env.clipboard.writeText(command);
      vscode.window.showInformationMessage(`Copied: ${command}`);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("kaimon")) {
        reschedule();
        void tick();
      }
    }),
    {
      dispose: () => {
        if (timer) {
          clearInterval(timer);
        }
      },
    },
  );

  reschedule();
  void tick();
}

export function deactivate(): void {
  if (timer) {
    clearInterval(timer);
  }
}
