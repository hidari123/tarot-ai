import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const PORT = 9960 + Math.floor(Math.random()*20);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const dir = mkdtempSync(join(tmpdir(),"obj-"));
const chrome = spawn(CHROME,["--headless=new","--disable-gpu","--no-first-run","--disable-extensions",`--remote-debugging-port=${PORT}`,`--user-data-dir=${dir}`,"--window-size=1200,900","about:blank"],{stdio:"ignore"});
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
class CDP{constructor(ws){this.ws=ws;this.id=0;this.p=new Map();ws.addEventListener("message",e=>{const m=JSON.parse(e.data);if(m.id&&this.p.has(m.id)){const{resolve,reject}=this.p.get(m.id);this.p.delete(m.id);m.error?reject(new Error(m.error.message)):resolve(m.result);}});}send(method,params={}){const id=++this.id;this.ws.send(JSON.stringify({id,method,params}));return new Promise((res,rej)=>{this.p.set(id,{resolve:res,reject:rej});setTimeout(()=>{if(this.p.has(id)){this.p.delete(id);rej(new Error("timeout"))}},40000);});}}
try{
  for(let i=0;i<60;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/version`);if(r.ok)break;}catch{}await sleep(250);}
  const pages=await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const pg=pages.find(p=>p.type==="page");
  const ws=new WebSocket(pg.webSocketDebuggerUrl);
  await new Promise((r,j)=>{ws.addEventListener("open",r);ws.addEventListener("error",j);});
  const c=new CDP(ws);
  await c.send("Runtime.enable");await c.send("Page.enable");
  await c.send("Emulation.setDeviceMetricsOverride",{width:1200,height:900,deviceScaleFactor:1,mobile:false});
  await c.send("Page.navigate",{url:"http://localhost:3001/"});
  await sleep(12000);
  const r=await c.send("Runtime.evaluate",{expression:`(()=>{
    const imgs=[...document.querySelectorAll('img')].filter(i=>i.src.includes('orb-witch'));
    return JSON.stringify(imgs.map(i=>{
      const cs=getComputedStyle(i); const b=i.getBoundingClientRect();
      return {
        natural: i.naturalWidth+'x'+i.naturalHeight,
        css: cs.width+'x'+cs.height,
        rect: Math.round(b.x)+','+Math.round(b.y)+' '+Math.round(b.width)+'x'+Math.round(b.height),
        objectFit: cs.objectFit,
        opacity: cs.opacity,
      };
    }),null,1);})()`,returnByValue:true});
  console.log(r.result?.value);
}catch(e){console.error("ERR",e.message);}finally{chrome.kill();}
