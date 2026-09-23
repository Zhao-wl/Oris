import { expect, it } from "vitest";
import { errorText } from "./error-message";
it("keeps concrete IPC reasons and identifies legacy tagged errors", () => {
  expect(errorText({kind:"staleRequest"})).toContain("刷新");
  expect(errorText({kind:"unsafePath"})).toContain("链接");
  expect(errorText({kind:"unknownRepository"})).toContain("载入");
  expect(errorText({kind:"unsupportedGit",message:{found:"2.20",minimum:"2.31"}})).toBe("Git 2.20 低于最低支持版本 2.31");
  expect(errorText({kind:"io",message:"文件不存在：new.json"})).toBe("文件不存在：new.json");
  expect(errorText(new Error("worker error"))).toBe("worker error");
  expect(errorText({kind:"futureFailure"})).toContain("futureFailure");
});
