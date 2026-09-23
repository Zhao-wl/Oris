import { describe, expect, it } from "vitest";
import { canvasGeometry } from "./ImageViewer";
import { ContentCache } from "./workspace-model";
import type { ContentPair, ImagePayload } from "./types";
const image = (width: number, height: number) => ({displayWidth:width,displayHeight:height}) as ImagePayload;
describe("image shared coordinates", () => {
 it("fits unequal images at one scale without stretching", () => {
  expect(canvasGeometry([image(100,200),image(300,100)],624,224,2,null)).toEqual({width:300,height:200,scale:.96});
  expect(canvasGeometry([image(100,200),image(300,100)],624,224,1,2)).toEqual({width:300,height:200,scale:2});
 });
 it("does not retain image payloads in text cache", () => {
  const cache=new ContentCache();
  cache.set("image",{left:{byteLength:10,details:{image:image(1,1)}},right:{byteLength:0}} as ContentPair);
  expect(cache.stats().entries).toBe(0);
 });
});
