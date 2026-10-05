/*
 * Maya World/User Agent Runtime v0.1.0
 * Runtime/context firewall around the existing Maya D100 preset.
 */
const MODULE="maya_world_user_agent", META_KEY="maya_world_user_agent_state";
const DEFAULT={enabled:false,autoRun:true,historyMessages:24,maxLedgerEntries:40,injectDepth:2,debug:false};
let running=false,uiReady=false;

function ctx(){return window.SillyTavern?.getContext?.()||null}
function settings(){const c=ctx(); const b=c?.extensionSettings?.[MODULE]||{}; return {...DEFAULT,...b}}
function bag(){const c=ctx(); if(!c)return {}; c.extensionSettings=c.extensionSettings||{}; c.extensionSettings[MODULE]=c.extensionSettings[MODULE]||{...DEFAULT}; return c.extensionSettings[MODULE]}
function log(...a){if(settings().debug)console.log("[MWU]",...a)}
function warn(...a){console.warn("[MWU]",...a)}
function state(){
 const c=ctx(); if(!c)return null;
 c.chatMetadata=c.chatMetadata||{};
 c.chatMetadata[META_KEY]=c.chatMetadata[META_KEY]||{version:1,turn:0,pov:"LOCAL",world:{time:"",location:"",active_events:[],npc_updates:[],relation_updates:[]},ledger:[]};
 return c.chatMetadata[META_KEY];
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
 for(let i=a.length-1;i>=0;i--){const m=a[i];if(m&&(m.is_user===true||m.role==="user"))return String(m.mes??m.content??"").trim()}
 return "";
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
function normWorld(w){
 w=w&&typeof w==="object"?w:{};
 return {
  pov_mode:w.pov_mode==="GLOBAL"?"GLOBAL":"LOCAL",
  visible_context:arr(w.visible_context).slice(0,12).map(x=>str(x,1800)).filter(Boolean),
  reveals:arr(w.reveals).slice(0,12).map(x=>str(x,1800)).filter(Boolean),
  patch:{
   time:str(w.state_patch?.time,300),location:str(w.state_patch?.location,500),
   active_events:arr(w.state_patch?.active_events).slice(0,12).map(x=>str(x,800)),
   npc_updates:arr(w.state_patch?.npc_updates).slice(0,12).map(x=>({id:str(x?.id,100),state:str(x?.state,1000),knowledge_delta:str(x?.knowledge_delta,600),attention:Number.isFinite(+x?.attention)?Math.max(0,Math.min(5,+x.attention)):null})),
   relation_updates:arr(w.state_patch?.relation_updates).slice(0,12).map(x=>({a:str(x?.a,100),b:str(x?.b,100),change:str(x?.change,500)})),
   background_add:arr(w.state_patch?.background_add).slice(0,12).map(x=>({id:str(x?.id,100),when:str(x?.when,200),where:str(x?.where,300),actors:arr(x?.actors).slice(0,8).map(v=>str(v,100)),event:str(x?.event,1000),current_state:str(x?.current_state,800),pending_consequence:str(x?.pending_consequence,800),reveal_condition:str(x?.reveal_condition,800)})),
   background_resolve:arr(w.state_patch?.background_resolve).slice(0,12).map(x=>str(x,100))
  }
 }
}
function merge(s,w){
 s.turn=(+s.turn||0)+1;s.pov=w.pov_mode;
 s.world=s.world||{time:"",location:"",active_events:[],npc_updates:[],relation_updates:[]};
 if(w.patch.time)s.world.time=w.patch.time;if(w.patch.location)s.world.location=w.patch.location;
 if(w.patch.active_events.length)s.world.active_events=w.patch.active_events;
 if(w.patch.npc_updates.length)s.world.npc_updates=w.patch.npc_updates;
 if(w.patch.relation_updates.length)s.world.relation_updates=w.patch.relation_updates;
 s.ledger=Array.isArray(s.ledger)?s.ledger:[];
 for(const e of w.patch.background_add){const old=s.ledger.find(x=>x.id===e.id);if(old)Object.assign(old,e);else s.ledger.push({...e,status:"hidden"})}
 for(const id of w.patch.background_resolve){const e=s.ledger.find(x=>x.id===id);if(e)e.status="resolved"}
 s.ledger=s.ledger.slice(-Math.max(5,+settings().maxLedgerEntries||40));return s
}
function inject(v){
 const c=ctx(),f=c?.setExtensionPrompt||window.setExtensionPrompt;if(typeof f!=="function")return;
 const types=c?.extension_prompt_types||window.extension_prompt_types||{IN_PROMPT:0};
 const roles=c?.extension_prompt_roles||window.extension_prompt_roles||{SYSTEM:0};
 f("MAYA_WORLD_USER_RUNTIME",v||"",types.IN_PROMPT,+settings().injectDepth||2,false,roles.SYSTEM)
}
function clear(){inject("")}
function runtimePrompt(u,w){
 const visible=[...arr(w.visible_context),...arr(w.reveals)].map(x=>str(x,1800)).filter(Boolean);
 return "<maya_runtime>\n<user_result>\n"+str(u.user_interpretation,2500)+"\n</user_result>\n<world_visible>\n"+visible.join("\n")+
 "\n</world_visible>\n<pov>"+w.pov_mode+"</pov>\n<rules>Hidden WORLD ledger is not user knowledge. Do not invent user choices, dialogue, motives or memories. NPC knowledge is local to each NPC. Continue world simulation naturally.</rules>\n</maya_runtime>";
}
async function run(){
 const c=ctx(),s=settings(); if(!c||!s.enabled||running)return;
 const input=latestUser();if(!input)return;
 running=true;
 try{
  const st=state();
  const up=`You are the USER PROCESSOR in a roleplay runtime. You are NOT the GM and NOT an NPC manager.
Persona:
${persona()}
Actual user input:
${input}
Return JSON only:
{"user_interpretation":"...","explicit_actions":["..."],"explicit_dialogue":["..."],"user_state_notes":["..."]}
Rules: preserve only what the user actually said or clearly implied. Never invent new decisions, intentions, dialogue, memories or motives.`;
  const ur=json(await raw(up));
  const wp=`You are the WORLD ENGINE. Simulate the world, NPCs, time, consequences, D100 logic already defined by the preset, attention and background events.
The USER_RESULT below is the only user-side action input. Do not invent user decisions.
Current hidden WORLD STATE:
${JSON.stringify(st)}
Recent chat:
${JSON.stringify(history())}
USER_RESULT:
${JSON.stringify(ur)}
Return JSON only:
{"pov_mode":"LOCAL|GLOBAL","visible_context":["facts the main narrator is allowed to use now"],"reveals":["information that reaches the user through witnessing, report, trace, rumor or consequence"],"state_patch":{"time":"","location":"","active_events":[],"npc_updates":[{"id":"","state":"","knowledge_delta":"","attention":0}],"relation_updates":[{"a":"","b":"","change":""}],"background_add":[{"id":"","when":"","where":"","actors":[],"event":"","current_state":"","pending_consequence":"","reveal_condition":""}],"background_resolve":[]}}
Rules: GLOBAL is internal simulation, not omniscient user knowledge. Awareness != Interest. Attention needs causal reason. Hidden background events remain hidden until a valid reveal channel exists. NPC knowledge is not shared automatically. Do not write hidden ledger into visible_context/reveals.`;
  const wr=normWorld(await quiet(wp));merge(st,wr);saveState(st);inject(runtimePrompt(ur,wr));log("runtime",ur,wr);
 }catch(e){warn(e);clear()}finally{running=false}
}
function reset(){
 const c=ctx(),fresh={version:1,turn:0,pov:"LOCAL",world:{time:"",location:"",active_events:[],npc_updates:[],relation_updates:[]},ledger:[]};
 if(c?.chatMetadata)c.chatMetadata[META_KEY]=fresh;if(typeof c?.updateChatMetadata==="function")c.updateChatMetadata({[META_KEY]:fresh});clear();
 if(window.toastr?.success)toastr.success("Maya World/User: state reset.")
}
function ui(){
 if(uiReady)return;const host=document.querySelector("#extensions_settings2")||document.querySelector("#extensions_settings");if(!host)return;uiReady=true;
 const d=document.createElement("div");d.className="mwu-settings inline-drawer";d.innerHTML=`<div class="inline-drawer-toggle inline-drawer-header"><b>Maya World/User Agent Runtime</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div><div class="inline-drawer-content"><label><input id="mwu_enabled" type="checkbox"> Enable runtime</label><label><input id="mwu_auto" type="checkbox"> Run automatically before normal generation</label><label>History <input id="mwu_history" type="number" min="4" max="80"></label><label>Ledger max <input id="mwu_ledger" type="number" min="5" max="200"></label><label>Injection depth <input id="mwu_depth" type="number" min="0" max="20"></label><label><input id="mwu_debug" type="checkbox"> Debug console</label><div class="mwu-buttons"><button id="mwu_run" class="menu_button">Run agents now</button><button id="mwu_reset" class="menu_button">Reset current chat state</button></div><pre id="mwu_status"></pre></div>`;
 host.appendChild(d);const s=settings();
 $("#mwu_enabled").prop("checked",s.enabled);$("#mwu_auto").prop("checked",s.autoRun);$("#mwu_history").val(s.historyMessages);$("#mwu_ledger").val(s.maxLedgerEntries);$("#mwu_depth").val(s.injectDepth);$("#mwu_debug").prop("checked",s.debug);
 function bind(id,k,cast=v=>v){$(id).on("change",function(){bag()[k]=cast(this.type==="checkbox"?this.checked:this.value);ctx()?.saveSettingsDebounced?.()})}
 bind("#mwu_enabled","enabled");bind("#mwu_auto","autoRun");bind("#mwu_history","historyMessages",Number);bind("#mwu_ledger","maxLedgerEntries",Number);bind("#mwu_depth","injectDepth",Number);bind("#mwu_debug","debug");
 $("#mwu_run").on("click",run);$("#mwu_reset").on("click",reset);
 setInterval(()=>$("#mwu_status").text(`enabled=${settings().enabled}, auto=${settings().autoRun}, turn=${state()?.turn||0}, pov=${state()?.pov||"LOCAL"}, hiddenLedger=${state()?.ledger?.length||0}, running=${running}`),1500)
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
