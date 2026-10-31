/**
 * Guards the stylesheet's token discipline: `npm test -w @agentfabric/web`.
 *
 * `style.css` is the whole UI's paint. Before the design-system pass it had
 * drifted into a private palette: three near-identical greys for the same
 * "secondary text" idea, ten font sizes, nine radii, and a handful of
 * `var(--name)` references to tokens nobody had defined — those render as
 * "declaration dropped", so the property silently falls back to the browser
 * default and the element looks wrong with no error anywhere.
 *
 * A comment cannot stop that from creeping back, so each rule below fails the
 * build instead:
 *
 * 1. Every `var(--x)` resolves to a `--x` declared in this file.
 * 2. No `var(--x, fallback)` — an inline fallback is how a wrong token name
 *    keeps looking right on one surface and wrong on the next.
 * 3. No `var(--x))` / unbalanced parentheses from scripted edits.
 * 4. No `!important`-free colour literals and no raw px in the two places the
 *    scale exists for: `font-size` and `border-radius`. A new size or radius is
 *    a token addition, not a literal.
 * 5. Every colour the file uses is declared in `:root`; nothing else carries a
 *    hex literal.
 *
 * The rule list is deliberately about *shape*, not taste: it cannot tell you
 * whether a colour is pretty, only that it came from the token block.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cssPath = resolve(here, "../src/style.css");
const css = readFileSync(cssPath, "utf8");

const rootStart = css.indexOf(":root {");
if (rootStart === -1) {
  console.error("[style-tokens] no :root block — the token layer is gone");
  process.exit(1);
}
const rootEnd = css.indexOf("\n}", rootStart) + 2;
const rootBlock = css.slice(rootStart, rootEnd);
// The token block is the only place colour literals are allowed; everything
// after it must reference a token.
const body = css.slice(rootEnd);

const failures = [];

/** 1. Every var() resolves. */
const defined = new Set();
for (const match of rootBlock.matchAll(/^\s*(--[a-z0-9-]+)\s*:/gm)) defined.add(match[1]);
const used = new Map();
for (const match of body.matchAll(/var\((--[a-z0-9-]+)/g)) {
  const name = match[1];
  if (!used.has(name)) {
    const line = body.slice(0, match.index).split("\n").length;
    used.set(name, line);
  }
}
for (const [name, line] of used) {
  if (!defined.has(name)) failures.push(`line ${line}: var(${name}) is never defined in :root`);
}

/** 2. No inline fallbacks. */
for (const match of body.matchAll(/var\(\s*--[a-z0-9-]+\s*,/g)) {
  failures.push(`line ${body.slice(0, match.index).split("\n").length}: var() with an inline fallback — declare the token instead`);
}

/** 3. Every declaration's parentheses balance.
 *
 * A scripted rewrite once produced `background: var(--accent-soft));`, which
 * invalidates the declaration and silently drops the property. Counting per
 * declaration catches that without tripping on `repeat(7, var(--heat-cell))`,
 * where the second ")" is the outer function's own. */
for (const [index, rawLine] of body.split("\n").entries()) {
  const line = rawLine.trim();
  if (!line.endsWith(";") || line.startsWith("/*") || line.startsWith("*")) continue;
  let depth = 0;
  for (const char of line) {
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    if (depth < 0) break;
  }
  if (depth !== 0) {
    const lineNo = css.slice(0, rootEnd).split("\n").length + index;
    failures.push(`line ${lineNo}: ${line.slice(0, 60)} — unbalanced "(" / ")"`);
  }
}

/** 4. The two scales that exist must be used. */
for (const match of body.matchAll(/^\s*font-size:\s*[0-9.]+(px|rem|em)/gm)) {
  failures.push(`line ${body.slice(0, match.index).split("\n").length}: raw font-size — use one of the --fs-* steps`);
}
for (const match of body.matchAll(/^\s*border-radius:\s*[0-9.]+px/gm)) {
  failures.push(`line ${body.slice(0, match.index).split("\n").length}: raw border-radius — use one of the --radius-* steps`);
}

/** 5. No colour literals outside the token block. */
for (const match of body.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
  failures.push(`line ${body.slice(0, match.index).split("\n").length}: colour literal ${match[0]} outside :root`);
}

if (failures.length > 0) {
  console.error(`[style-tokens] ${failures.length} problem(s) in packages/web/src/style.css:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}

console.log(`[style-tokens] ok — ${defined.size} tokens defined, ${used.size} referenced, no literals outside :root`);
