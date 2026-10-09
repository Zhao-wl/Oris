import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { reviewAttachments } from "./review";
import { planAiAction } from "../ai-api";
import { REVIEW_CONTRACT } from "./model";
import { explainAttachments, EXPLAIN_CONTRACT } from "../context-selection/explain";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

it.runIf(process.env.ORIS_REAL_REVIEW === "1")("real Git pages -> production joint orchestration -> real CLI model -> validated related sources", async () => {
  const child = spawn("cargo", ["test", "--manifest-path", "src-tauri/Cargo.toml", "--no-default-features", "--lib", "real_review_protocol_bridge", "--", "--ignored", "--nocapture"], { windowsHide: true, stdio: "pipe" });
  const waiters = new Map(); let serial = 0, stateUnchanged = false;
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let diagnostics = "";
  child.stderr.on("data", data => { diagnostics = (diagnostics + data.toString()).slice(-4000); });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", line => {
    if (!line.startsWith("ORIS_REVIEW_BRIDGE=")) return;
    const result = JSON.parse(line.slice("ORIS_REVIEW_BRIDGE=".length));
    if (result.ready) readyResolve(result.inventory);
    else if (result.stateUnchanged) stateUnchanged = true;
    else { if (result.value?.bridgeError) waiters.get(result.id)?.reject(new Error(result.value.bridgeError)); else waiters.get(result.id)?.resolve(result.value); waiters.delete(result.id); }
  });
  const completed = new Promise((resolve, reject) => {
    const fail = (error) => { readyReject(error); for (const waiter of waiters.values()) waiter.reject(error); reject(error); };
    child.on("error", fail);
    child.on("exit", code => { if (code === 0) resolve(); else fail(new Error(`bridge exit ${code}: ${diagnostics}`)); });
  });
  // Register failure handling before the first read to avoid an unhandled exit promise.
  void completed.catch(() => {});
  const modelCalls = [];
  invoke.mockImplementation(async (command, args) => {
    if (child.exitCode !== null) throw new Error(`bridge already exited: ${diagnostics}`);
    const id = ++serial;
    const response = new Promise((resolve, reject) => waiters.set(id, { resolve, reject }));
    child.stdin.write(JSON.stringify({ id, command, args }) + "\n");
    const value = await response;
    if (command === "plan_ai_action") modelCalls.push({ context: args.context, response: value });
    return value;
  });
  try {
    const inventory = await ready;
    const attachments = inventory.files.map((file) => ({ id: file.pathId, kind: "files", repoId: inventory.repoId, label: file.path, path: file.path, source: "unstaged",
      request: { range: inventory.range, identity: inventory.identity, pathIds: [file.pathId], contextPaths: [] } }));
    const profile = { id: "smoke", name: "Smoke", kind: "cli", provider: "codex", executable: "", baseUrl: "", model: process.env.ORIS_REVIEW_SMOKE_MODEL, hasKey: false };
    const description = "@审查 联合核对 price 的行为、调用方和测试契约。报告有证据的回归，并引用相关文件原文；只读，不运行测试。";
    const { result } = await reviewAttachments(inventory.repoId, attachments, () => true,
      review => planAiAction(profile, description, { review, capability: { answer: true } }, REVIEW_CONTRACT, "real-review", true), { description, system: REVIEW_CONTRACT });
    expect(modelCalls).toHaveLength(1); expect(result?.findings.length).toBeGreaterThan(0);
    expect(result?.findings.every(f => f.source && !f.invalid)).toBe(true);
    expect(result?.findings.some(f => f.source?.file.path === "price.ts" && f.references?.some(r => ["caller.ts", "price.test.ts"].includes(r.source?.file.path ?? "")))).toBe(true);
    expect(new Set(result?.context.sources.map(s => s.file.path))).toEqual(new Set(["price.ts", "caller.ts", "price.test.ts", "config.json"]));
    if (process.env.ORIS_SNAPSHOT_EDIT === "1") {
      expect(result.context.warnings.join()).toContain("本轮结论保留");
      expect(result.context.sources.some(s => s.file.path === "price.ts" && s.side === "right" && s.lines.some(l => l.text.includes("n / 2")))).toBe(true);
      await invoke("restore_review_fixture", {});
    }
    const reviewCalls = modelCalls.slice();
    const explanation = await explainAttachments(inventory.repoId, attachments, () => true,
      attachments => planAiAction(profile, "@解释", { attachments, capability: { answer: true } }, EXPLAIN_CONTRACT, "real-explain", true), { description: "@解释", system: EXPLAIN_CONTRACT });
    const explanationCalls = modelCalls.slice(reviewCalls.length);
    expect(explanationCalls).toHaveLength(1);
    expect(new Set(explanationCalls[0].context.attachments.sources.map(s => s.file.path))).toEqual(new Set(["price.ts", "caller.ts", "price.test.ts", "config.json"]));
    expect(explanation.message).toContain("price"); expect(explanation.message).toContain("caller");
    expect(explanation.message).toContain("已遍历 4 项");
    expect(explanation.message).not.toMatch(/请(?:指定|选择|提供).{0,10}(?:文件|范围)/);
    if (process.env.ORIS_SNAPSHOT_EDIT === "1") { expect(explanation.message).toContain("本轮结论保留"); await invoke("restore_review_fixture", {}); }
    child.stdin.end(); await completed; expect(stateUnchanged).toBe(true);
    if (process.env.ORIS_REVIEW_PIPELINE_EVIDENCE) writeFileSync(process.env.ORIS_REVIEW_PIPELINE_EVIDENCE, JSON.stringify({ model: profile.model, provider: "codex", reviewCalls, result, explanationCalls, explanation, controlledEditDuringModel: process.env.ORIS_SNAPSHOT_EDIT === "1", stateUnchanged, coverage: "生产 TS 审查和解释编排 -> 真实 Git 只读 API -> 生产 CLI -> 真实模型 -> 前端来源校验；不含原生 GUI" }, null, 2));
  } finally { child.stdin.end(); lines.close(); if (child.exitCode === null) child.kill(); invoke.mockReset(); }
}, 300000);
