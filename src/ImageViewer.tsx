import { useEffect, useRef, useState } from "react";
import type { TextSide, ImagePayload } from "./types";

export function canvasGeometry(images: (ImagePayload | null | undefined)[], availableWidth: number, availableHeight: number, panels: number, zoom: number | null) {
  const width = Math.max(1, ...images.map(image => image?.displayWidth ?? 0));
  const height = Math.max(1, ...images.map(image => image?.displayHeight ?? 0));
  const scale = zoom ?? Math.min(1, Math.max(1, availableWidth / panels - 24) / width, Math.max(1, availableHeight - 24) / height);
  return { width, height, scale };
}
function useImageUrl(payload: ImagePayload | null | undefined) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!payload) { setUrl(undefined); return; }
    const bytes = payload.bytes ?? Uint8Array.from(atob(payload.base64), char => char.charCodeAt(0));
    const next = URL.createObjectURL(new Blob([bytes as BlobPart], { type: payload.mime }));
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [payload]);
  return url;
}
export default function ImageViewer({ left, right, labels }: { left: TextSide; right: TextSide; labels: readonly string[] }) {
  const a = left.details?.image, b = right.details?.image;
  const aUrl = useImageUrl(a), bUrl = useImageUrl(b);
  const [mode, setMode] = useState("split");
  const [background, setBackground] = useState("checker");
  const [zoom, setZoom] = useState<number | null>(null);
  const [divider, setDivider] = useState(50);
  const [failed, setFailed] = useState<Record<number, boolean>>({});
  const [size, setSize] = useState({ width: 800, height: 500 });
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!viewport.current) return;
    const observer = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    observer.observe(viewport.current);
    return () => observer.disconnect();
  }, []);
  const sides = [left, right];
  const visible = [0, 1].filter(index => sides[index].encoding !== "missing");
  const sliding = mode === "slide" && !!a && !!b && !failed[0] && !failed[1];
  const geometry = canvasGeometry(a || b ? [a, b] : [{ displayWidth: 300, displayHeight: 120 } as ImagePayload], size.width, size.height, sliding ? 1 : Math.max(1, visible.length), zoom);
  const image = (index: number) => {
    const payload = sides[index].details?.image;
    return payload && !failed[index] ? <img alt={labels[index]} src={index === 0 ? aUrl : bUrl} draggable={false} onError={() => setFailed(current => ({ ...current, [index]: true }))} style={{ width: payload.displayWidth * geometry.scale, height: payload.displayHeight * geometry.scale }}/>
      : <p className="image-reason">{failed[index] ? "当前 WebView 图片解码失败" : sides[index].details?.reason ?? "此侧无法作为图片显示"}</p>;
  };
  return <section className="image-viewer" aria-label="图片比较">
    <div className="image-tools"><select aria-label="图片布局" value={mode} onChange={event => setMode(event.target.value)}><option value="split">并排</option><option value="slide" disabled={!a || !b}>滑动</option></select>
      <button onClick={() => setZoom(null)}>适应视图</button><button onClick={() => setZoom(1)}>原始尺寸</button>
      <button aria-label="缩小" onClick={() => setZoom(Math.max(.05, geometry.scale / 1.25))}>−</button><output>{Math.round(geometry.scale * 100)}%</output><button aria-label="放大" onClick={() => setZoom(Math.min(8, geometry.scale * 1.25))}>+</button>
      <select aria-label="透明背景" value={background} onChange={event => setBackground(event.target.value)}><option value="checker">棋盘格</option><option value="light">浅色</option><option value="dark">深色</option></select>
      {sliding && <input aria-label="滑动分界" type="range" min="0" max="100" value={divider} onChange={event => setDivider(Number(event.target.value))}/>}
    </div>
    <div className="image-metadata">{sides.map((side, index) => <div key={index}><strong>{labels[index]}</strong> · {side.encoding === "missing" ? "缺失 / 删除" : side.details?.sizeKnown === false ? "字节数未知" : `${side.byteLength.toLocaleString()} 字节`}{side.details?.lfsOid && <span title={`LFS sha256 ${side.details.lfsOid}`}> · Git LFS</span>}{side.details?.image && <span> · {side.details.image.mime} · 存储 {side.details.image.width}×{side.details.image.height} · 展示 {side.details.image.displayWidth}×{side.details.image.displayHeight} · EXIF {side.details.image.orientation}</span>}{side.details?.reason && <p>{side.details.reason}</p>}</div>)}</div>
    <div ref={viewport} className="image-viewport"><div className="image-panels">
      {sliding ? <div className={`image-canvas ${background}`} style={{ width: geometry.width * geometry.scale, height: geometry.height * geometry.scale }}>{image(0)}<div className={`image-overlay image-canvas ${background}`} style={{ clipPath: `inset(0 ${100 - divider}% 0 0)` }}>{image(1)}</div><div className="image-divider" style={{ left: `${divider}%` }}/></div>
        : visible.map(index => <div key={index} className={`image-canvas ${background}`} style={{ width: geometry.width * geometry.scale, height: geometry.height * geometry.scale }}>{image(index)}</div>)}
    </div></div><small>同一坐标原点与倍率；按 EXIF 方向展示，不承诺专业色彩或像素一致性。</small>
  </section>;
}
