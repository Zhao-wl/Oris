import type { DiffDocument } from "./types";

let worker: Worker | null = null;

function getWorker() {
  worker ??= new Worker(new URL("./diff-worker.ts", import.meta.url), { type: "module" });
  return worker;
}

export function calculateDiff(
  requestId: string,
  contentIds: [string, string],
  left: string,
  right: string
): Promise<DiffDocument> {
  const activeWorker = getWorker();
  return new Promise((resolve, reject) => {
    const onMessage = (event: MessageEvent<DiffDocument>) => {
      if (event.data.requestId !== requestId) return;
      cleanup();
      resolve(event.data);
    };
    const onError = (event: ErrorEvent) => {
      cleanup();
      reject(new Error(event.message || "Diff Worker 失败"));
    };
    const cleanup = () => {
      activeWorker.removeEventListener("message", onMessage);
      activeWorker.removeEventListener("error", onError);
    };
    activeWorker.addEventListener("message", onMessage);
    activeWorker.addEventListener("error", onError);
    activeWorker.postMessage({ requestId, contentIds, left, right });
  });
}
