import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const stylesheet = readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../src/styles.css"), "utf8");

/**
 * 禁止写死颜色（V2-06 接入清单第 4 条）：界面颜色必须来自配色方案写入的 CSS 变量。
 * 允许：`var(--x, 回退)` 中的回退值（即 Oris 原配色）、`:root` 默认变量块、中性灰（阴影 / 遮罩 / 图片背景），
 * 以及品牌色白名单。
 */
const BRAND_SELECTORS = [".logo"];

function stripFallbacks(css) {
  let previous;
  do {
    previous = css;
    css = css.replace(/var\(--[\w-]+,\s*(?:[^()]|\([^()]*\))*\)/g, "var()");
  } while (css !== previous);
  return css;
}

function channels(color) {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(([^)]*)\)$/i.exec(color)?.[1];
  return fn ? fn.split(/[\s,/]+/).slice(0, 3).map(Number) : null;
}

const isNeutral = (color) => { const c = channels(color); return !!c && c.every((v) => v === c[0]); };

function findOffenders(source) {
  const css = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const offenders = [];
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = rule[1].trim();
    if (/^:root(\.theme-light)?$/.test(selector)) continue;
    if (BRAND_SELECTORS.includes(selector)) continue;
    const body = stripFallbacks(rule[2]);
    for (const match of body.matchAll(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi)) {
      if (!isNeutral(match[0])) offenders.push(`${selector} → ${match[0]}`);
    }
  }
  return offenders;
}

it("styles.css has no hard-coded non-neutral colors outside variable fallbacks and the :root defaults", () => {
  expect(stylesheet.length).toBeGreaterThan(1000);
  expect(findOffenders(stylesheet)).toEqual([]);
});

it("the check itself catches a colored literal and accepts fallbacks and neutral grays", () => {
  expect(stripFallbacks("color:var(--a, #ff0000); background:var(--b, var(--c, #00ff00))")).not.toMatch(/#/);
  expect(isNeutral("#8884")).toBe(true);
  expect(isNeutral("#0009")).toBe(true);
  expect(isNeutral("#e2b71499")).toBe(false);
  expect(isNeutral("rgba(10, 10, 10, .5)")).toBe(true);
  expect(findOffenders(":root { --bg:#123456; }\n.a { color:#f00; background:var(--x, #0f0); box-shadow:0 0 0 1px #0008; }\n.logo { background:#7165d3; }")).toEqual([".a → #f00"]);
});
