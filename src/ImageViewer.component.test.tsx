// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ImageViewer from "./ImageViewer";
import type { TextSide } from "./types";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
const revoke = vi.fn();
URL.createObjectURL = vi.fn(() => "blob:fixture"); URL.revokeObjectURL = revoke;
const side = (w: number, h: number): TextSide => ({endpoint:"head",text:null,encoding:"binary-or-unsupported",byteLength:10,eol:"none",hasFinalNewline:null,contentId:`${w}:${h}`,details:{state:"ready",reason:null,oid:null,mode:null,image:{mime:"image/png",base64:"AA==",width:w,height:h,displayWidth:w,displayHeight:h,orientation:1}}});
afterEach(() => { document.body.innerHTML=""; vi.clearAllMocks(); });
it("keeps unequal image geometry, changes slide/background/zoom, releases every URL over 30 mounts", async () => {
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 for(let index=0;index<30;index++) {
  await act(async()=>root.render(<ImageViewer key={index} left={side(100,200)} right={side(300,100)} labels={["旧","新"]}/>));
 }
 expect(URL.createObjectURL).toHaveBeenCalledTimes(60);expect(revoke).toHaveBeenCalledTimes(58);
 const layout=host.querySelector('[aria-label="图片布局"]') as HTMLSelectElement;
 await act(async()=>{layout.value="slide";layout.dispatchEvent(new Event("change",{bubbles:true}));});
 expect(host.querySelectorAll(".image-overlay")).toHaveLength(1);
 expect(host.querySelectorAll("img")[0].style.width).toBe("100px");
 expect(host.querySelectorAll("img")[1].style.width).toBe("300px");
 const slider=host.querySelector('[aria-label="滑动分界"]') as HTMLInputElement;
 expect(slider).not.toBeNull();
 await act(async()=>{(host.querySelector('[aria-label="放大"]') as HTMLButtonElement).click();});
 expect(host.querySelectorAll("img")[0].style.width).toBe("125px");
 expect(host.querySelectorAll("img")[1].style.width).toBe("375px");
 await act(async()=>root.unmount());expect(revoke).toHaveBeenCalledTimes(60);
});
it("missing side is one canvas; unavailable side remains explicit and valid image survives", async()=>{
 const host=document.createElement("div");document.body.append(host);const root=createRoot(host);
 const missing={...side(1,1),encoding:"missing",details:null} as TextSide;
 await act(async()=>root.render(<ImageViewer left={missing} right={side(30,20)} labels={["旧","新"]}/>));
 expect(host.querySelectorAll(".image-canvas")).toHaveLength(1);expect(host.querySelector('[aria-label="滑动分界"]')).toBeNull();
 const bad={...side(1,1),details:{state:"unavailable",reason:"坏图",image:null,oid:null,mode:null}} as TextSide;
 await act(async()=>root.render(<ImageViewer left={bad} right={side(30,20)} labels={["旧","新"]}/>));
 expect(host.querySelectorAll("img")).toHaveLength(1);expect(host.textContent).toContain("坏图");
 await act(async()=>root.unmount());
});
