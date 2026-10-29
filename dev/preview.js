// Render the panel headlessly, without launching an Extension Development Host.
//
// Copy and layout are the parts of this extension that need the most iteration,
// and the install -> reload loop is far too slow for that. This stubs the
// `vscode` module the panel imports, runs the real render path against the real
// sink on this host, and writes the HTML plus a plain-text version.
//
//   node dev/preview.js [window]     e.g. node dev/preview.js 1h
//
// Dev only: excluded from the vsix by .vscodeignore.

const Module = require("module");
const fs = require("fs");
const path = require("path");

const cfg = { path: "kaimon", window: process.argv[2] || "15m", refreshSeconds: 30 };

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === "vscode") {
    return {
      workspace: { getConfiguration: () => ({ get: (k, d) => cfg[k] ?? d }) },
      window: { createStatusBarItem: () => ({ show() {}, dispose() {} }) },
      commands: { registerCommand: () => ({ dispose() {} }) },
      MarkdownString: class { constructor(v) { this.value = v; } },
      ViewColumn: { One: 1 },
      ThemeColor: class {},
      StatusBarAlignment: { Right: 2 },
    };
  }
  return load.call(this, request, ...rest);
};

const cli = require("../out/cli.js");
const panel = require("../out/panel.js");
const ext = require("../out/extension.js");

function text(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/g, "")
    .replace(/<script[\s\S]*?<\/script>/g, "")
    .replace(/<\/(p|h1|h2|li|footer|summary)>/g, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&middot;/g, "\u00b7")
    .replace(/&ndash;/g, "\u2013")
    .replace(/&mdash;/g, "\u2014")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .split("\n")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

(async () => {
  const [r, collecting] = await Promise.all([cli.report(), cli.daemonActive()]);
  const html = panel.activityBody(r, collecting, "PREVIEW");
  const out = path.join(__dirname, "preview.html");
  fs.writeFileSync(out, html);
  console.log(`window ${cfg.window} · collecting ${collecting} · needsReview ${cli.needsReview(r)}`);
  console.log(`wrote ${out}\n`);
  console.log(text(html));
  console.log("\n===== STATUS BAR HOVER =====");
  console.log(ext.tooltip(r, collecting, Date.now() - 15000).value);
})();
