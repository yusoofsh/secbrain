export const appBridge = String.raw`const byId = id => document.getElementById(id);
const pending = new Map(); let sequence=0, parentOrigin=null, ready=false, busy=false, modelContext=false, shared=false;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
const label = (value, fallback='Unknown') => typeof value === 'string' || typeof value === 'number' ? String(value) : fallback;
const el = (tag,text,cls) => { const item=document.createElement(tag); if(text!==undefined)item.textContent=String(text); if(cls)item.className=cls; return item; };
function notice(text){ byId('notice').textContent=text; }
function send(message){ window.parent.postMessage(message,parentOrigin||'*'); }
function request(method,params){return new Promise((resolve,reject)=>{const id=++sequence; const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Request timed out'));},60000);pending.set(id,{resolve,reject,timer});send({jsonrpc:'2.0',id,method,params});});}
function setBusy(value){busy=value; document.querySelectorAll('[data-read]').forEach(button=>{button.disabled=!ready||busy;});updateButtons();}
function applyContext(context){if(context?.theme==='dark'||context?.theme==='light')document.documentElement.style.colorScheme=context.theme;if(typeof context?.locale==='string')document.documentElement.lang=context.locale;}
window.addEventListener('message',event=>{if(event.source !== window.parent)return;if(parentOrigin && event.origin!==parentOrigin)return;const m=event.data;if(!m||m.jsonrpc!=='2.0')return;
 if((typeof m.id==='number'||typeof m.id==='string') && pending.has(m.id) && ('result' in m || 'error' in m)){const p=pending.get(m.id);clearTimeout(p.timer);pending.delete(m.id);if(!parentOrigin && event.origin!=='null')parentOrigin=event.origin;if(m.error)p.reject(new Error('Host request failed'));else p.resolve(m.result);return;}
 if(m.method==='ui/notifications/tool-result'){if(!busy)receive(m.params);}
 if(m.method==='ui/notifications/host-context-changed')applyContext(m.params);
 if(m.method==='ui/resource-teardown'){for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('View closed'));}pending.clear();if(m.id!==undefined)send({jsonrpc:'2.0',id:m.id,result:{}});}
});
async function read(name,args){if(!ready||busy||!allowedTools.has(name))return;setBusy(true);notice('Reading…');try{const result=await request('tools/call',{name,arguments:args});if(result?.isError)throw new Error('Read failed');receive(result);notice('Read complete. No stored data was changed.');}catch{notice('The read failed. Previous results may be stale. Retry explicitly.');}finally{setBusy(false);}}
async function shareSelection(){if(!modelContext||!selectedText)return;try{await request('ui/update-model-context',{content:[{type:'text',text:selectedText.slice(0,12000)}]});shared=true;notice('Selected context is available to the next message. No message was sent.');}catch{notice('The host did not accept context. The selected text remains visible.');}}
async function clearSharedContext(){if(shared){try{await request('ui/update-model-context',{content:[]});shared=false;}catch{notice('The host could not clear the previous shared context.');}}}
byId('share').addEventListener('click',shareSelection);
async function start(){try{const init=await request('ui/initialize',{appInfo:{name:appName,version:'1.0.0'},appCapabilities:{},protocolVersion:'2026-01-26'});modelContext=Boolean(init?.hostCapabilities?.updateModelContext);applyContext(init?.hostContext);send({jsonrpc:'2.0',method:'ui/notifications/initialized',params:{}});ready=true;setBusy(false);notice('Connected. Choose a read or select existing results.');onReady();}catch{notice('Open this view in an MCP Apps-compatible host. The read tools remain available without this view.');}}
void start();`;
