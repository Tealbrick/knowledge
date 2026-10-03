import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const source = readFileSync(new URL("../src/tokens.css", import.meta.url), "utf8");
const blocks = [...source.matchAll(/:root(?:\[data-theme="dark"\])?\s*\{([^}]+)\}/g)].map(match => Object.fromEntries([...match[1].matchAll(/(--dg-[\w-]+):\s*(#[a-f0-9]{6})\s*;/gi)].map(token => [token[1], token[2]])));
const luminance = hex => hex.slice(1).match(/../g).map(c => parseInt(c, 16) / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
const contrast = (a, b) => { const values = [luminance(a), luminance(b)].sort((x, y) => y - x); return (values[0] + .05) / (values[1] + .05); };
for (const [i, tokens] of blocks.entries()) {
  const theme = i === 0 ? "light" : "dark";
  for (const [foreground, background] of [["--dg-on-accent", "--dg-burgundy"], ["--dg-on-accent", "--dg-burgundy-deep"], ["--dg-ink", "--dg-paper"], ["--dg-muted", "--dg-paper"], ["--dg-danger", "--dg-paper"], ["--dg-warning", "--dg-paper"], ["--dg-success", "--dg-paper"]]) {
    test(`${theme} ${foreground} on ${background} has normal-text contrast`, () => assert.ok(contrast(tokens[foreground], tokens[background]) >= 4.5, `${contrast(tokens[foreground], tokens[background]).toFixed(2)} < 4.5`));
  }
}
test("both theme blocks were checked", () => assert.equal(blocks.length, 2));
test("shared geometry remains centralized", () => { for (const [name, value] of [["control", 4], ["surface", 6], ["modal", 8]]) assert.match(source, new RegExp(`--dg-radius-${name}: ${value}px;`)); });
