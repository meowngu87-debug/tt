/*
 * Maya World/User Agent Runtime v0.1.0
 * Runtime/context firewall around the existing Maya D100 preset.
 */
const MODULE="maya_world_user_agent", META_KEY="maya_world_user_agent_state";
const DEFAULT={enabled:false,autoRun:true,historyMessages:24,maxLedgerEntries:60,maxNpcs:80,maxFacts:120,maxVisibleItems:12,injectDepth:2,debug:false};
let running=false,uiReady=false;

function ctx(){return window.SillyTavern?.getContext?.()||null}
function settings(){const c=ctx(); const b=c?.extensionSettings?.[MODULE]||{}; return {...DEFAULT,...b}}
function bag(){const c=ctx(); if(!c)return {}; c.extensionSettings=c.extensionSettings||{}; c.extensionSettings[MODULE]=c.extensionSettings[MODULE]||{...DEFAULT}; return c.extensionSettings[MODULE]}
function log(...a){if(settings().debug)console.log("[MWU]",...a)}
function warn(...a){console.warn("[MWU]",...a)}
function state(){
 const c=ctx(); if(!c)return null;
 c.chatMetadata=c.chatMetadata||{};
 let s=c.chatMetadata[META_KEY];
 if(!s||typeof s!=="object")s={version:2,turn:0,pov:"LOCAL",world:{time:"",location:"",active_events:[]},npcs:{},relationships:{},knowledge:{user:[],npc:{}},events:{},background_ledger:[],reveals:[],runtime:{last_user_hash:"",last_user_index:-1}};
 s.world=s.world||{time:"",location:"",active_events:[]};
 s.npcs=s.npcs||{};s.relationships=s.relationships||{};s.knowledge=s.knowledge||{user:[],npc:{}};
 s.knowledge.user=Array.isArray(s.knowledge.user)?s.knowledge.user:[];s.knowledge.npc=s.knowledge.npc||{};
 s.events=s.events||{};s.background_ledger=Array.isArray(s.background_ledger)?s.background_ledger:(Array.isArray(s.ledger)?s.ledger:[]);
 s.reveals=Array.isArray(s.reveals)?s.reveals:[];s.runtime=s.runtime||{last_user_hash:"",last_user_index:-1};
 s.version=2;
 const npcEntries=Object.entries(s.npcs).slice(-Math.max(10,Number(settings().maxNpcs)||80));s.npcs=Object.fromEntries(npcEntries);
 s.knowledge.user=[...new Set(s.knowledge.user.map(x=>String(x||"").trim()).filter(Boolean))].slice(-Math.max(20,Number(settings().maxFacts)||120));
 s.background_ledger=s.background_ledger.slice(-Math.max(10,Number(settings().maxLedgerEntries)||60));
 s.reveals=s.reveals.slice(-Math.max(20,Number(settings().maxFacts)||120));
 c.chatMetadata[META_KEY]=s;
 return s;
}
function saveState(s){
 const c=ctx(); if(!c)return;
 c.chatMetadata=c.chatMetadata||{}; c.chatMetadata[META_KEY]=s;
 if(typeof c.updateChatMetadata==="function")c.updateChatMetadata({[META_KEY]:s});
 if(typeof c.saveMetadata==="function")c.saveMetadata(); else if(typeof c.saveChat==="function")c.saveChat();
}
function persona(){
 const c=ctx(); try{
  if(typeof c?.substituteParams==="function")return String(c.substituteParams("{{persona}}")||"").trim();
  if(typeof window.substituteParams==="function")return String(window.substituteParams("{{persona}}")||"").trim();
 }catch(e){} return "";
}
function latestUser(){
 const a=ctx()?.chat||[];
 for(let i=a.length-1;i>=0;i--){const m=a[i];if(m&&(m.is_user===true||m.role==="user"))return {index:i,text:String(m.mes??m.content??"").trim()}}
 return {index:-1,text:""};
}
function history(){
 const a=ctx()?.chat||[], n=Math.max(4,Number(settings().historyMessages)||24);
 return a.slice(-n).map(m=>({role:m?.is_user?"user":(m?.role||"assistant"),name:m?.name||"",content:String(m?.mes??m?.content??"").slice(0,5000)}));
}
async function raw(prompt){
 const f=ctx()?.generateRaw||window.generateRaw;
 if(typeof f!=="function")throw Error("generateRaw unavailable");
 return await f({prompt});
}
async function quiet(prompt){
 const f=ctx()?.generateQuietPrompt||window.generateQuietPrompt;
 if(typeof f!=="function")throw Error("generateQuietPrompt unavailable");
 return await f({quietPrompt:prompt});
}
function json(s){
 s=String(s||"").trim();
 try{return JSON.parse(s)}catch(e){}
 const m=s.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/i);
 if(m)try{return JSON.parse(m[1])}catch(e){}
 const a=s.indexOf("{"),b=s.lastIndexOf("}");
 if(a>=0&&b>a)try{return JSON.parse(s.slice(a,b+1))}catch(e){}
 throw Error("Agent returned invalid JSON");
}
function arr(x){return Array.isArray(x)?x:[]}
function str(x,n=1600){return String(x??"").trim().slice(0,n)}
function uniq(x){return [...new Set(arr(x).map(v=>str(v,1200)).filter(Boolean))]}
function hash(x){let h=2166136261;const s=String(x??"");for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}return (h>>>0).toString(16)}
function normWorld(w){
 w=w&&typeof w==="object"?w:{};
 const p=w.state_patch&&typeof w.state_patch==="object"?w.state_patch:{};
 return {
  pov_mode:w.pov_mode==="GLOBAL"?"GLOBAL":"LOCAL",
  visible_context:uniq(w.visible_context).slice(0,Number(settings().maxVisibleItems)||12),
  reveals:arr(w.reveals).slice(0,12).map(x=>({event_id:str(x?.event_id,120),channel:["witnessed","heard","reported","rumor","trace","consequence","inference"].includes(x?.channel)?x.channel:"",text:str(x?.text,1800)})).filter(x=>x.text&&x.channel),
  patch:{
   time:str(p.time,300),location:str(p.location,500),
   active_events:uniq(p.active_events).slice(0,20),
   npcs:arr(p.npcs).slice(0,20).map(x=>({id:str(x?.id,120),role:str(x?.role,300),state:str(x?.state,1200),location:str(x?.location,300),knowledge_add:uniq(x?.knowledge_add).slice(0,8),awareness:Number.isFinite(+x?.awareness)?Math.max(0,Math.min(5,+x.awareness)):null,interest:Number.isFinite(+x?.interest)?Math.max(0,Math.min(5,+x.interest)):null})).filter(x=>x.id),
   relationships:arr(p.relationships).slice(0,20).map(x=>({a:str(x?.a,120),b:str(x?.b,120),change:str(x?.change,800)})).filter(x=>x.a&&x.b&&x.change),
   events:arr(p.events).slice(0,20).map(x=>({id:str(x?.id,120)||("evt_"+hash([x?.state,x?.status].join("|"))),status:str(x?.status,80),state:str(x?.state,1000)})),
   background_add:arr(p.background_add).slice(0,20).map(x=>({id:str(x?.id,120)||("bg_"+hash([x?.when,x?.where,x?.event].join("|"))),when:str(x?.when,200),where:str(x?.where,300),actors:uniq(x?.actors).slice(0,8),event:str(x?.event,1000),current_state:str(x?.current_state,800),pending_consequence:str(x?.pending_consequence,800),reveal_condition:str(x?.reveal_condition,800)})).filter(x=>x.event),
   background_resolve:uniq(p.background_resolve).slice(0,20)
  }
 }
}
function merge(s,w){
 s.turn=(+s.turn||0)+1;s.pov=w.pov_mode;
 s.world=s.world||{time:"",location:"",active_events:[]};
 if(w.patch.time)s.world.time=w.patch.time;if(w.patch.location)s.world.location=w.patch.location;
 if(w.patch.active_events.length)s.world.active_events=w.patch.active_events;
 s.npcs=s.npcs||{};s.relationships=s.relationships||{};s.events=s.events||{};
 s.knowledge=s.knowledge||{user:[],npc:{}};s.knowledge.npc=s.knowledge.npc||{};
 for(const n of w.patch.npcs){
  const old=s.npcs[n.id]||{id:n.id,knowledge:[]};
  s.npcs[n.id]={...old,id:n.id,role:n.role||old.role||"",state:n.state||old.state||"",location:n.location||old.location||"",awareness:n.awareness??old.awareness??0,interest:n.interest??old.interest??0,knowledge:uniq([...(old.knowledge||[]),...n.knowledge_add]).slice(-20),last_update_turn:s.turn};
  s.knowledge.npc[n.id]=uniq([...(s.knowledge.npc[n.id]||[]),...n.knowledge_add]).slice(-20);
 }
 for(const r of w.patch.relationships){const key=[r.a,r.b].sort().join("::");s.relationships[key]={a:r.a,b:r.b,change:r.change,last_update_turn:s.turn}}
 for(const e of w.patch.events){s.events[e.id]={...(s.events[e.id]||{}),...e,last_update_turn:s.turn}}
 s.background_ledger=Array.isArray(s.background_ledger)?s.background_ledger:[];
 for(const e of w.patch.background_add){const old=s.background_ledger.find(x=>x.id===e.id);if(old)Object.assign(old,e);else s.background_ledger.push({...e,status:"hidden"});s.events[e.id] ||= {id:e.id,type:"background",status:"hidden"}}
 for(const id of w.patch.background_resolve){const e=s.background_ledger.find(x=>x.id===id);if(e)e.status="resolved";if(s.events[id])s.events[id].status="resolved"}
 for(const r of w.reveals){const e=r.event_id&&s.background_ledger.find(x=>x.id===r.event_id);if(e)e.status="revealed";s.reveals.push({turn:s.turn,event_id:r.event_id,channel:r.channel,text:r.text});s.knowledge.user.push(r.text)}
 return state();
}
function inject(v){
 const c=ctx(),f=c?.setExtensionPrompt||window.setExtensionPrompt;if(typeof f!=="function")return;
 const types=c?.extension_prompt_types||window.extension_prompt_types||{IN_PROMPT:0};
 const roles=c?.extension_prompt_roles||window.extension_prompt_roles||{SYSTEM:0};
 f("MAYA_WORLD_USER_RUNTIME",v||"",types.IN_PROMPT,+settings().injectDepth||2,false,roles.SYSTEM)
}
function clear(){inject("")}
function runtimePrompt(u,w){
 const visible=[...arr(w.visible_context),...arr(w.reveals).map(x=>"["+x.channel+"] "+x.text)].map(x=>str(x,1800)).filter(Boolean).slice(0,Number(settings().maxVisibleItems)||12);
 return "<maya_runtime>\n<user_result>\n"+str(u.user_interpretation,2500)+"\n</user_result>\n<world_visible>\n"+visible.join("\n")+
 "\n</world_visible>\n<pov>"+w.pov_mode+"</pov>\n<rules>Hidden WORLD state is not user knowledge. Do not invent user choices, dialogue, motives or memories. NPC knowledge is local. Continue ongoing events naturally.</rules>\n</maya_runtime>";
}
async function run(){
 const c=ctx(),cfg=settings();if(!c||!cfg.enabled||running)return false;
 const current=latestUser();if(!current.text)return false;
 const s=state(),fingerprint=hash(current.index+"|"+current.text);
 if(s.runtime.last_user_hash===fingerprint&&s.runtime.last_user_index===current.index){log("duplicate turn ignored",fingerprint);return false}
 running=true;
 try{
  const up=`You are the USER PROCESSOR. You are NOT the GM, narrator, or NPC manager.
Persona:
${persona()}
Actual user input:
${current.text}
Return JSON only:
{"user_interpretation":"...","explicit_actions":["..."],"explicit_dialogue":["..."],"user_state_notes":["..."]}
Rules: preserve only what the user actually said or clearly implied. Never invent new user decisions, intentions, dialogue, memories, motives or emotions. Do not simulate NPCs or the world.`;
  const ur=json(await raw(up));
  const wp=`You are the WORLD ENGINE of a persistent roleplay simulation.
The world continues between user turns. Advance ongoing NPC activity, time, consequences and background events when causally appropriate.
The existing preset remains authoritative for D100, Action Roll, World Roll, dice veto, Character Autonomy, OCC and prose. Do not replace them.
USER_RESULT:
${JSON.stringify(ur)}
CURRENT HIDDEN WORLD STATE:
${JSON.stringify({turn:s.turn,pov:s.pov,world:s.world,npcs:s.npcs,relationships:s.relationships,events:s.events,background_ledger:s.background_ledger,knowledge:{npc:s.knowledge.npc}})}
RECENT CHAT:
${JSON.stringify(history())}
Return JSON only:
{"pov_mode":"LOCAL|GLOBAL","visible_context":["facts safe for the main narrator to use now"],"reveals":[{"event_id":"optional hidden event id","channel":"witnessed|heard|reported|rumor|trace|consequence|inference","text":"what becomes knowable now"}],"state_patch":{"time":"","location":"","active_events":[],"npcs":[{"id":"","role":"","state":"","location":"","knowledge_add":[],"awareness":0,"interest":0}],"relationships":[{"a":"","b":"","change":""}],"events":[{"id":"","status":"","state":""}],"background_add":[{"id":"","when":"","where":"","actors":[],"event":"","current_state":"","pending_consequence":"","reveal_condition":""}],"background_resolve":[]}}
Rules:
- GLOBAL is internal simulation scope, NOT automatic user knowledge.
- LOCAL is the user-facing perception window when relevant.
- Awareness is not Interest. Attention requires a causal reason.
- NPC knowledge is local to each NPC and is never globally shared.
- Background events remain hidden until a valid reveal channel exists.
- Never put hidden ledger details into visible_context.
- Never invent a user decision, dialogue, motive, memory or intention.
- Do not reset established state without cause.
- If nothing meaningful changes, preserve state rather than manufacturing drama.
- Continue ongoing events naturally even when they are off-screen.`;
  const wr=normWorld(await quiet(wp));
  merge(s,wr);s.runtime.last_user_hash=fingerprint;s.runtime.last_user_index=current.index;saveState(s);
  inject(runtimePrompt(ur,wr));log("turn committed",s.turn);
  return true;
 }catch(e){warn(e);clear()}finally{running=false}
 return false;
}
function reset(){
 const c=ctx(),fresh={version:1,turn:0,pov:"LOCAL",world:{time:"",location:"",active_events:[],npc_updates:[],relation_updates:[]},ledger:[]};
 if(c?.chatMetadata)c.chatMetadata[META_KEY]=fresh;if(typeof c?.updateChatMetadata==="function")c.updateChatMetadata({[META_KEY]:fresh});clear();
 if(window.toastr?.success)toastr.success("Maya World/User: state reset.")
}
function ui(){
 if(uiReady)return;const host=document.querySelector("#extensions_settings2")||document.querySelector("#extensions_settings");if(!host)return;uiReady=true;
 const d=document.createElement("div");d.className="mwu-settings inline-drawer";d.innerHTML=`<div class="inline-drawer-toggle inline-drawer-header"><b>Maya World/User Agent Runtime</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label><input id="mwu_enabled" type="checkbox"> Enable runtime</label><label><input id="mwu_auto" type="checkbox"> Run automatically before normal generation</label><label>History <input id="mwu_history" type="number" min="4" max="80"></label><label>Ledger max <input id="mwu_ledger" type="number" min="10" max="200"></label><label>NPC max <input id="mwu_npcs" type="number" min="10" max="200"></label><label>Known facts max <input id="mwu_facts" type="number" min="20" max="500"></label><label>Injection depth <input id="mwu_depth" type="number" min="0" max="20"></label><label><input id="mwu_debug" type="checkbox"> Debug console</label><div class="mwu-buttons"><button id="mwu_run" class="menu_button">Run agents now</button><button id="mwu_reset" class="menu_button">Reset current chat state</button></div><pre id="mwu_status"></pre></div>`;
 host.appendChild(d);const s=settings();
 $("#mwu_enabled").prop("checked",s.enabled);$("#mwu_auto").prop("checked",s.autoRun);$("#mwu_history").val(s.historyMessages);$("#mwu_ledger").val(s.maxLedgerEntries);$("#mwu_npcs").val(s.maxNpcs);$("#mwu_facts").val(s.maxFacts);$("#mwu_depth").val(s.injectDepth);$("#mwu_debug").prop("checked",s.debug);
 function bind(id,k,cast=v=>v){$(id).on("change",function(){bag()[k]=cast(this.type==="checkbox"?this.checked:this.value);ctx()?.saveSettingsDebounced?.()})}
 bind("#mwu_enabled","enabled");bind("#mwu_auto","autoRun");bind("#mwu_history","historyMessages",Number);bind("#mwu_ledger","maxLedgerEntries",Number);bind("#mwu_npcs","maxNpcs",Number);bind("#mwu_facts","maxFacts",Number);bind("#mwu_depth","injectDepth",Number);bind("#mwu_debug","debug");
 $("#mwu_run").on("click",run);$("#mwu_reset").on("click",reset);
 setInterval(()=>$("#mwu_status").text(`enabled=${settings().enabled}, auto=${settings().autoRun}, turn=${state()?.turn||0}, pov=${state()?.pov||"LOCAL"}, npcs=${Object.keys(state()?.npcs||{}).length}, events=${Object.keys(state()?.events||{}).length}, hidden=${state()?.background_ledger?.filter(x=>x.status==="hidden").length||0}, running=${running}`),1500)
}
globalThis.MayaWorldAgent_interceptGeneration=async function(chat,contextSize,abort,type){
 const s=settings();if(!s.enabled||!s.autoRun||running)return chat;
 if(type&&!["normal","impersonate"].includes(type))return chat;
 await run();return chat
};
function init(){
 const c=ctx();if(!c){setTimeout(init,1000);return}
 c.extensionSettings=c.extensionSettings||{};c.extensionSettings[MODULE]={...DEFAULT,...(c.extensionSettings[MODULE]||{})};c.saveSettingsDebounced?.();
 const t=setInterval(()=>{if(document.querySelector("#extensions_settings2")||document.querySelector("#extensions_settings")){clearInterval(t);ui()}},500);
 if(c.eventSource&&c.event_types){const e=c.eventSource,t=c.event_types;e.on(t.GENERATION_ENDED,clear);e.on(t.GENERATION_STOPPED,clear);e.on(t.CHAT_CHANGED,clear)}
 console.log("[MWU] loaded")
}
setTimeout(init,0);
