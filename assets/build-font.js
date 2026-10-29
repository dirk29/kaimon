// Regenerates assets/kaimon-actors.woff from assets/actor-svg/*.svg.
//
// Run from this directory after installing the pipeline:
//   npm i --no-save svgicons2svgfont svg2ttf ttf2woff && node build-font.js
//
// PROVENANCE, per glyph — this matters if the marketplace listing is ever
// reviewed:
//
//   claude  official. Derived from Anthropic's own claude-logo.svg, shipped
//           in their anthropic.claude-code extension.
//   codex   official. Derived from OpenAI's blossom-white.svg, shipped in
//           their openai.chatgpt extension.
//   mcp     official. Derived from Model_Context_Protocol_logo.svg on
//           Wikimedia Commons: MIT licensed AND below the threshold of
//           originality (public domain). The source is STROKE based, which an
//           icon font cannot use, so it was converted with
//             inkscape mcp-official.svg --actions="select-all;object-stroke-to-path;..."
//           MIT grants the right to modify, which is why this one may be
//           recolored where the vendor marks may not.
//   kaimon  ours. The eye from the kaimon logo (assets/images, and the site
//           favicon), brow and eye outline merged into one path. The pupil
//           needs no subtraction — it is already a counter-wound subpath of
//           the eye, so it stays a hole under the nonzero fill a font uses.
//   copilot official. GitHub's copilot.svg, shipped in their own Copilot CLI
//           package (@github/copilot-linux-*, assets/), badge circle removed.
//   opencode official. opencode-logo-dark-square.svg from the brand folder of
//           OpenCode's own repository (MIT), the assets its brand page serves;
//           the frame alone, as one color cannot show its dark inner tone.
//   junie   official. Junie_icon.svg from JetBrains' own brand asset server
//           (resources.jetbrains.com).
//   antigravity official. The one-color icon from Google's Antigravity press
//           assets (antigravity.google/press).
//   pi      official. pi.dev/logo-auto.svg, from the project's own site; its
//           three colors merged into one shape.
//   cline   official. icon.svg shipped in Cline's own extension
//           (saoudrizwan.claude-dev, assets/icons/), its two rounded-rect eyes
//           written as path arcs.
//   kilo    official. kilo-dark.svg shipped in Kilo Code's own extension
//           (kilocode.kilo-code, assets/icons/): the yellow tile alone, its
//           letters already cut out of it.
//   others  drawn for kaimon from geometry, not copied from anyone.
//
// Official marks are displayed unmodified and uncolored beyond a neutral, to
// identify whose agent acted — ordinary referential use. Nothing here was
// taken from a THIRD party's redraw of a logo, which would add that party's
// license on top of the vendor's terms.
//
// SIZE is set by each SVG's viewBox: a mark cropped to its shape fills the
// em. Solid square marks look larger than round or open ones at the same
// height, so pi, opencode and kilo carry a margin that draws them at 85%, and
// antigravity, copilot and cline at 92%. The mark itself is unchanged.
//
// Codepoints are PRIVATE USE and positional: package.json maps each icon id to
// a fixed fontCharacter, so a new glyph must be APPENDED. Renumbering silently
// swaps every icon in the UI.
const fs = require("fs");
const { SVGIcons2SVGFontStream } = require("svgicons2svgfont");
const svg2ttf = require("svg2ttf");
const ttf2woff = require("ttf2woff");

// Private Use Area, one codepoint per actor. Order is fixed: adding a glyph
// must append, never renumber, or every shipped package.json mapping shifts.
const GLYPHS = ["claude", "codex", "gemini", "cursor", "mcp", "kaimon", "copilot", "opencode", "junie", "antigravity", "pi", "cline", "kilo"];
const START = 0xe900;

const font = new SVGIcons2SVGFontStream({ fontName: "kaimon-actors", normalize: true, fontHeight: 1000, descent: 150, log: () => {} });
const chunks = [];
font.on("data", (c) => chunks.push(c));
font.on("end", () => {
  const svgFont = chunks.join("");
  fs.writeFileSync("kaimon-actors.svg", svgFont);
  const ttf = svg2ttf(svgFont, {});
  const woff = ttf2woff(Buffer.from(ttf.buffer));
  fs.writeFileSync("kaimon-actors.woff", Buffer.from(woff.buffer));
  GLYPHS.forEach((g, i) => console.log(`  ${g.padEnd(8)} U+${(START + i).toString(16).toUpperCase()}`));
  console.log(`  -> kaimon-actors.woff ${fs.statSync("kaimon-actors.woff").size} bytes`);
});
GLYPHS.forEach((name, i) => {
  const s = fs.createReadStream(`actor-svg/${name}.svg`);
  s.metadata = { unicode: [String.fromCharCode(START + i)], name };
  font.write(s);
});
font.end();
