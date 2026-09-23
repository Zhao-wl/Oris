import {mkdirSync,writeFileSync,existsSync,mkdtempSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join,resolve} from 'node:path';
const output=process.argv[2] ?? 'artifacts/task-02-feedback';
mkdirSync(output,{recursive:true});
const root=mkdtempSync(join(output,'bench-'));
const git=(...args)=>{const r=spawnSync('git',['-C',root,...args],{stdio:'ignore'});if(r.status!==0)throw Error(`git ${args[0]} failed (${r.status})`)};
mkdirSync(root,{recursive:true});
if(!existsSync(join(root,'.git'))){
git('init','-q');git('config','core.autocrlf','false');git('config','gc.auto','0');git('config','user.name','Oris fixture');git('config','user.email','fixture@example.invalid');
for(let i=0;i<10000;i++){const dir=join(root,'client/Assets/中文 # [路径]/VeryLongDirectory/Renderer/Feature'+Math.floor(i/100));mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`file-${String(i).padStart(5,'0')}.txt`),Array.from({length:i<100?1800:20},(_,n)=>`line ${n} baseline ${i}`).join('\n')+'\n')}
git('add','.');git('commit','-qm','baseline');
for(let i=0;i<100;i++){const p=join(root,'client/Assets/中文 # [路径]/VeryLongDirectory/Renderer/Feature0',`file-${String(i).padStart(5,'0')}.txt`);writeFileSync(p,Array.from({length:1800},(_,n)=>`line ${n} ${n%100===0?'changed':'baseline'} ${i}`).join('\n')+'\n')}
git('add','.');
for(let i=0;i<100;i++){const p=join(root,'client/Assets/中文 # [路径]/VeryLongDirectory/Renderer/Feature0',`file-${String(i).padStart(5,'0')}.txt`);writeFileSync(p,Array.from({length:1800},(_,n)=>`line ${n} ${n%80===0?'working':'baseline'} ${i}`).join('\n')+'\n')}
}
writeFileSync(join(output,'fixture.json'),JSON.stringify({root:resolve(root),tracked:10000,changed:100,linesPerChangedFile:1800}));console.log(root);
