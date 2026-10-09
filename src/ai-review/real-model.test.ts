import { expect, it } from "vitest";
import evidence from "./validation/real-model.json";
import { parseReview, type ReviewContext } from "./model";
it("the recorded real model response survives the exact production frontend evidence validator", () => {
  const result = parseReview(evidence.response.review, evidence.context as ReviewContext);
  expect(result.findings.length).toBeGreaterThan(0);
  expect(result.findings.every(f => f.source && !f.invalid)).toBe(true);
  expect(result.findings.some(f => f.source?.file.path === "price.ts")).toBe(true);
  expect(evidence.gitStateUnchanged).toBe(true);
});
it("the real smoke actually supplied caller, configuration and test contents", () => {
  const paths = new Set(evidence.context.sources.filter(s => s.lines.length).map(s => s.file.path));
  expect(paths).toEqual(new Set(["caller.ts", "price.ts", "config.json", "price.test.ts"]));
  expect(evidence.response.kind).toBe("answer"); expect(evidence.provider).toBe("codex");
});
