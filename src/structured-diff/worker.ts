import { compareStructured, type StructuredFormat } from "./model";

self.addEventListener("message", ({ data }: MessageEvent<{ format: StructuredFormat; left: string | null; right: string | null }>) => {
  try {
    self.postMessage({ result: compareStructured(data.format, data.left, data.right) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : "无法分析结构" });
  }
});
