export default function FileViewSelect({value,onChange,label="文件显示方式"}:{value:"flat"|"tree";onChange(value:"flat"|"tree"):void;label?:string}) {
  return <select className="file-view-select" aria-label={label} title={value==="flat"?"平铺显示相对路径":"树状显示目录"} value={value} onChange={e=>onChange(e.target.value as "flat"|"tree")}><option value="flat">☷</option><option value="tree">⑂</option></select>;
}
