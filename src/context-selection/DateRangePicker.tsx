import { useEffect, useRef, useState } from "react";
export default function DateRangePicker({since,until,onChange}:{since:string;until:string;onChange(since:string,until:string):void}) {
  const [open,setOpen]=useState(false),[start,setStart]=useState(since),[end,setEnd]=useState(until);
  const host=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
  useEffect(()=>{if(!open)return;const close=(e:PointerEvent)=>{if(!host.current?.contains(e.target as Node))setOpen(false);};document.addEventListener("pointerdown",close);return()=>document.removeEventListener("pointerdown",close);},[open]);
  const finish=()=>{setOpen(false);trigger.current?.focus();};
  return <div className="cs-date" ref={host} onKeyDown={e=>{if(open&&e.key==="Escape"){e.stopPropagation();finish();}}}>
    <button ref={trigger} type="button" aria-label="提交日期区间" aria-expanded={open} onClick={()=>{setStart(since);setEnd(until);setOpen(v=>!v);}}>{since||until?`${since||"不限"} — ${until||"不限"}`:"日期区间"} ▾</button>
    {open&&<div className="cs-date-popover" role="dialog" aria-label="选择日期区间"><label>开始<input autoFocus type="date" aria-label="开始日期" value={start} max={end||undefined} onChange={e=>setStart(e.target.value)}/></label><label>结束<input type="date" aria-label="结束日期" value={end} min={start||undefined} onChange={e=>setEnd(e.target.value)}/></label>
      {start&&end&&start>end&&<span role="alert">结束日期不能早于开始日期</span>}
      <div><button onClick={()=>{onChange("","");finish();}}>清除日期</button><button onClick={finish}>取消</button><button className="primary" disabled={!!start&&!!end&&start>end} onClick={()=>{onChange(start,end);finish();}}>应用日期</button></div>
    </div>}
  </div>;
}
