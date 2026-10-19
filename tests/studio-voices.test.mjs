import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Isolated provider integration tests. Each harness has fresh modules/catalog
// caches; no API keys, accounts, subscriptions or paid provider calls are used.
const root=process.cwd(),alice="11111111-1111-4111-8111-111111111111",bob="22222222-2222-4222-8222-222222222222";
let harnessSequence=0;
async function harness(){
 const key=`offline-catalog-${++harnessSequence}`,requests=[],grants=new Map(),charged=[],deleted=[],media=new Map();
 let handle=async()=>{throw new Error("Unexpected provider request");};
 const environment={ELEVENLABS_API_KEY:key},modules=new Map(),synthetics=new Map();
 const context=vm.createContext({console,crypto,process:{env:environment},TextEncoder,TextDecoder,Uint8Array,DataView,ArrayBuffer,FormData,File,Request,Response,Headers,URL,URLSearchParams,AbortSignal,setTimeout,clearTimeout,btoa,atob,fetch:async(url,init={})=>{const request={url:String(url),method:init.method||"GET",...init};requests.push(request);return handle(request);}});
 const contractPath=path.join(root,"lib/studio-contract.ts");
 const failure=(code,message=code,status=422)=>new (modules.get(contractPath).namespace.StudioError)(code,message,status);
 const grant=(userId,voiceId,source="shared",name=voiceId)=>grants.set(`${userId}:${voiceId}`,{user_id:userId,voice_id:voiceId,source,name,authorization_tag:"already-verified-by-server"});
 const server={
  authorizedVoiceRows:async(userId)=>[...grants.values()].filter(row=>row.user_id===userId),
  saveAuthorizedVoice:async(userId,voiceId,name,source)=>grant(userId,voiceId,source,name),
  saveSharedVoiceList:async(userId,voices)=>{for(const voice of voices)grant(userId,voice.voiceId,"shared",voice.name);},
  consumeAiUnits:async(_user,units)=>charged.push(units),consumeVoiceClone:async(_user,units)=>charged.push(units),getMember:async()=>({role:"admin"}),sharedVoiceCatalog:async()=>[],modelNames:()=>({voiceModel:"eleven_flash_v2_5"}),voiceProvider:()=>"eleven",providerKey:async()=>({key,personal:false}),
  providerResponse:async(response)=>{if(!response.ok)throw failure("PROVIDER_REJECTED");return response;},
  requestUser:async()=>alice,limitedJson:async(request)=>request.json(),json:(data,status=200)=>Response.json(data,{status}),apiError:error=>Response.json({code:error.code,error:error.message},{status:error.status||500}),
 };
 const ownedPath=(userId,value)=>{if(typeof value!=="string"||!value.startsWith(userId+"/")||value.includes(".."))throw failure("MEDIA_NOT_AUTHORIZED","Forbidden",403);return value;};
 const mocks=new Map([
  [path.join(root,"lib/studio-server.ts"),server],
  [path.join(root,"lib/studio-deepseek.ts"),{shortenSegment:async()=>{throw new Error("No hidden AI retry permitted");}}],
  [path.join(root,"lib/studio-maziao.ts"),{authorizeMaziaoVoice:async()=>{throw new Error("Eleven voice-over must not authorize Maziao");},generateMaziaoVoiceOver:async()=>{throw new Error("Eleven voice-over must not call Maziao");}}],
  [path.join(root,"lib/studio-supabase.ts"),{assertOwnedMediaPath:ownedPath,downloadOwnedMedia:async(userId,name)=>{ownedPath(userId,name);return new File([new Uint8Array([1,2,3,4])],"sample.wav",{type:"audio/wav"});},removeOwnedMedia:async(userId,paths)=>{for(const name of paths){ownedPath(userId,name);deleted.push(name);media.delete(name);}},storeNarration:async(userId,wav,index)=>{const audioPath=`${userId}/narration/${index}.wav`;media.set(audioPath,wav);return{audioPath,audioUrl:`https://audio.example.invalid/${index}`};}}],
  [path.join(root,"lib/studio-credit-operation.ts"),{creditRequestId:()=>crypto.randomUUID()}],
 ]);
 async function load(file){
  if(modules.has(file))return modules.get(file);
  const code=ts.transpileModule(await fs.readFile(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
  const mod=new vm.SourceTextModule(code,{context,identifier:file});modules.set(file,mod);return mod;
 }
 async function linker(specifier,parent){
  const file=specifier==="server-only"?specifier:specifier.startsWith("@/")?path.join(root,specifier.slice(2))+".ts":path.resolve(path.dirname(parent.identifier),specifier)+".ts";
  if(file==="server-only"||mocks.has(file)){
   if(synthetics.has(file))return synthetics.get(file);
   const values=mocks.get(file)||{},mod=new vm.SyntheticModule(Object.keys(values),function(){for(const[name,value]of Object.entries(values))this.setExport(name,value);},{context});synthetics.set(file,mod);return mod;
  }
  return load(file);
 }
 async function entry(relative){const mod=await load(path.join(root,relative));if(mod.status==="unlinked")await mod.link(linker);if(mod.status!=="evaluated")await mod.evaluate();return mod.namespace;}
 const eleven=await entry("lib/studio-eleven.ts"),catalog=modules.get(path.join(root,"lib/studio-voice-catalog.ts")).namespace;
 return{key,environment,requests,grants,grant,charged,deleted,media,eleven,catalog,entry,setHandler:handler=>{handle=handler;}};
}
const raw=(id,extra={})=>({voice_id:id,public_owner_id:`public-owner-${id}`,name:id,language:"vi",cloned_by_count:100,use_case:"social_media",description:"Vietnamese conversational review",preview_url:`https://preview.example.invalid/${id}.mp3`,free_users_allowed:true,...extra});
const isCatalog=request=>request.url.includes("/shared-voices?");
const isVi=request=>new URL(request.url).searchParams.get("language")==="vi";
let passed=0;async function check(name,run){await run();console.log(`PASS ${name}`);passed++;}

await check("catalog curates ten unique Vietnamese voices and five popular voices with valid public ownership",async()=>{
 const {catalog}=await harness(),vi=Array.from({length:14},(_,index)=>raw(`vietVoice${index}`,{cloned_by_count:index}));
 vi.push(raw("vietVoice13",{cloned_by_count:999}),raw("wrongLanguage",{language:"en",verified_languages:[]}),raw("invalid/voice"),raw("noOwner",{public_owner_id:""}),null);
 vi.push(raw("verifiedVietnamese",{language:"en",verified_languages:[null,{language:"vi",accent:"southern",preview_url:"https://preview.example.invalid/vi.mp3"}],cloned_by_count:1000}));
 const popular=Array.from({length:8},(_,index)=>raw(`popularVoice${index}`,{language:"en",cloned_by_count:index+200}));popular.push(vi[0],popular[7]);
 const result=catalog.curateLibraryVoices(vi,popular),vietnamese=result.filter(voice=>voice.group==="vietnamese"),top=result.filter(voice=>voice.group==="popular");
 assert.equal(vietnamese.length,10);assert.equal(top.length,5);assert.equal(new Set(result.map(voice=>voice.voiceId)).size,15);assert.ok(vietnamese.every(voice=>voice.language==="vi"));assert.equal(vietnamese[0].voiceId,"verifiedVietnamese");assert.equal(vietnamese[0].accent,"southern");assert.equal(vietnamese[0].previewUrl,"https://preview.example.invalid/vi.mp3");assert.equal(top[0].voiceId,"popularVoice7");assert.ok(!result.some(voice=>["wrongLanguage","invalid/voice","noOwner"].includes(voice.voiceId)));
});
await check("catalog cache separates keys and uses the documented language and popularity queries",async()=>{
 const h=await harness();h.setHandler(request=>{assert.ok(isCatalog(request));const query=new URL(request.url).searchParams;assert.equal(query.get("sort"),"cloned_by_count");assert.equal(query.get("include_custom_rates"),"false");assert.equal(query.get("include_live_moderated"),"false");return Response.json({voices:isVi(request)?[raw(request.headers["xi-api-key"]===h.key?"firstKeyVoice":"secondKeyVoice")]:[]});});
 const first=await h.catalog.libraryCatalog(h.key);assert.equal(first[0].voiceId,"firstKeyVoice");await h.catalog.libraryCatalog(h.key);assert.equal(h.requests.length,2);
 const second=await h.catalog.libraryCatalog("offline-different-key");assert.equal(second[0].voiceId,"secondKeyVoice");assert.equal(h.requests.length,4);assert.ok(h.requests.some(request=>new URL(request.url).searchParams.get("page_size")==="100"));
});
await check("voice list hides foreign clones, forged grants, stale shared aliases and provider owner ids",async()=>{
 const h=await harness();h.grant(alice,"ownPersonal","personal","My personal voice");h.grant(bob,"bobPrivateClone","personal","Bob private");h.grant(alice,"staleSharedAlias","shared","Previously public");
 h.setHandler(request=>isCatalog(request)?Response.json({voices:isVi(request)?[raw("publicVietnamese")]:[]}):Response.json({voices:[{voice_id:"ownPersonal",name:"My personal voice",category:"cloned"},{voice_id:"bobPrivateClone",name:"Bob private",category:"cloned"},{voice_id:"staleSharedAlias",name:"Private after sharing",category:"cloned",preview_url:"https://private.example.invalid/secret-preview"},{voice_id:"defaultVoice",name:"Default",category:"premade"},{voice_id:"unsignedPrivate",name:"Unknown clone",category:"cloned"}]}));
 const voices=await h.eleven.listVoices(h.key,alice);assert.deepEqual(Array.from(voices,voice=>voice.voiceId),["publicVietnamese","ownPersonal","defaultVoice"]);assert.equal(voices.find(voice=>voice.voiceId==="ownPersonal").group,"personal");const text=JSON.stringify(voices);assert.ok(!text.includes("bobPrivateClone"));assert.ok(!text.includes("secret-preview"));assert.ok(!text.includes("public_owner_id"));assert.ok(!text.includes("public-owner-publicVietnamese"));
 assert.ok(h.grants.has(`${alice}:publicVietnamese`));assert.ok(!h.grants.has(`${alice}:bobPrivateClone`));
});
await check("an arbitrary or foreign clone id never reaches the provider import endpoint",async()=>{
 const h=await harness();h.grant(bob,"foreignClone","personal");h.setHandler(()=>{throw new Error("Unauthorized provider access");});
 await assert.rejects(h.eleven.authorizeVoice(alice,"foreignClone"),{code:"VOICE_NOT_AUTHORIZED"});await assert.rejects(h.eleven.authorizeVoice(alice,"publicButNoGrant"),{code:"VOICE_NOT_AUTHORIZED"});assert.equal(h.requests.length,0);assert.equal(h.charged.length,0);
});
await check("library selection imports only the current provider verified owner and returns its actual alias id",async()=>{
 const h=await harness();h.grant(alice,"publicVietnamese");
 h.setHandler(request=>{
  if(isCatalog(request))return Response.json({voices:isVi(request)?[raw("publicVietnamese")]:[]});
  if(request.url.endsWith("/user/subscription"))return Response.json({tier:"starter"});
  if(request.url.endsWith("/voices")&&request.method==="GET")return Response.json({voices:[{voice_id:"privateLookalike",category:"cloned",sharing:{original_voice_id:"publicVietnamese",public_owner_id:"wrong-owner"}}]});
  assert.equal(request.url,"https://api.elevenlabs.io/v1/voices/add/public-owner-publicVietnamese/publicVietnamese");assert.equal(request.method,"POST");assert.deepEqual(JSON.parse(request.body),{new_name:"publicVietnamese",bookmarked:false});return Response.json({voice_id:"importedPublicAlias"});
 });
 assert.equal(await h.eleven.authorizeVoice(alice,"publicVietnamese"),"importedPublicAlias");assert.ok(h.grants.has(`${alice}:importedPublicAlias`));assert.ok(!h.grants.has(`${alice}:privateLookalike`));assert.equal(h.charged.length,0);
});
await check("matching public aliases are reused and stale aliases with a mismatched owner are denied",async()=>{
 const h=await harness();h.grant(alice,"publicVietnamese");h.grant(alice,"staleSharedAlias");
 h.setHandler(request=>{
  if(isCatalog(request))return Response.json({voices:isVi(request)?[raw("publicVietnamese")]:[]});
  if(request.url.endsWith("/user/subscription"))return Response.json({tier:"starter"});
  if(request.url.endsWith("/voices"))return Response.json({voices:[{voice_id:"existingAlias",category:"cloned",sharing:{original_voice_id:"publicVietnamese",public_owner_id:"public-owner-publicVietnamese"}}]});
  if(request.url.endsWith("/voices/staleSharedAlias"))return Response.json({voice_id:"staleSharedAlias",category:"cloned",sharing:{original_voice_id:"publicVietnamese",public_owner_id:"wrong-owner"}});
  throw new Error("No import or synthesis expected");
 });
 assert.equal(await h.eleven.authorizeVoice(alice,"publicVietnamese"),"existingAlias");await assert.rejects(h.eleven.authorizeVoice(alice,"staleSharedAlias"),{code:"VOICE_NOT_AUTHORIZED"});assert.ok(h.requests.every(request=>request.method==="GET"));assert.equal(h.charged.length,0);
});
await check("speech route blocks unpriced ElevenLabs synthesis before any provider call",async()=>{
 const h=await harness();h.grant(alice,"publicVietnamese");
 h.setHandler(()=>{throw new Error("Paid provider request must stay disabled");});
 const route=await h.entry("app/api/speech/route.ts"),response=await route.POST(new Request("https://app.example/api/speech",{method:"POST",body:JSON.stringify({voiceId:"publicVietnamese",duration:5,segments:[{start:0,end:5,text:"Xin chào bạn."}]})}));
 assert.equal(response.status,503);assert.equal((await response.json()).code,"VOICE_PRICING_UNAVAILABLE");assert.deepEqual(h.charged,[]);assert.equal(h.media.size,0);assert.equal(h.requests.length,0);
});
await check("continuous Eleven voice-over blocks unpriced provider requests",async()=>{
 const h=await harness(),script="Đây là kịch bản đã được người dùng duyệt, không tự ý rút gọn.";
 h.grant(alice,"memberVoice","personal");
 h.setHandler(()=>{throw new Error("Paid provider request must stay disabled");});
 const route=await h.entry("app/api/voice-over/route.ts");
 const response=await route.POST(new Request("https://app.example/api/voice-over",{method:"POST",body:JSON.stringify({voiceId:"memberVoice",text:script,speed:1,volume:1,pitch:1})}));
 assert.equal(response.status,503);assert.equal((await response.json()).code,"VOICE_PRICING_UNAVAILABLE");assert.deepEqual(h.charged,[]);assert.equal(h.media.size,0);assert.equal(h.requests.length,0);
});
await check("clone entitlement distinguishes free, missing flags and a full paid plan",async()=>{
 const cases=[{plan:{tier:"free",can_use_instant_voice_cloning:false},code:"CLONING_PLAN_REQUIRED"},{plan:{tier:"starter"},code:"CLONING_ENTITLEMENT_UNKNOWN"},{plan:{tier:"starter",can_use_instant_voice_cloning:true,voice_slots_used:10,voice_limit:10},code:"VOICE_SLOTS_FULL"}];
 for(const item of cases){const h=await harness();h.setHandler(request=>{assert.ok(request.url.endsWith("/user/subscription"));return Response.json(item.plan);});await assert.rejects(h.catalog.assertCloningEntitlement(h.key),{code:item.code});assert.equal(h.charged.length,0);}
 const h=await harness();h.setHandler(()=>Response.json({tier:"starter",can_use_instant_voice_cloning:true,voice_slots_used:1,voice_limit:10}));await h.catalog.assertCloningEntitlement(h.key);
});
await check("unpriced ElevenLabs cloning cleans the uploaded sample without charging",async()=>{
 const h=await harness(),samplePath=`${alice}/voice-samples/sample.wav`;h.setHandler(()=>{throw new Error("Paid provider request must stay disabled");});
 const route=await h.entry("app/api/voices/route.ts"),response=await route.POST(new Request("https://app.example/api/voices",{method:"POST",body:JSON.stringify({name:"My voice",consent:true,samplePaths:[samplePath]})}));
 assert.equal(response.status,503);assert.equal((await response.json()).code,"VOICE_PRICING_UNAVAILABLE");assert.deepEqual(h.deleted,[samplePath]);assert.equal(h.charged.length,0);assert.equal(h.requests.length,0);
});
await check("public library voice cannot bypass unpriced ElevenLabs gate",async()=>{
 const h=await harness();h.grant(alice,"publicVietnamese");
 h.setHandler(()=>{throw new Error("Paid provider request must stay disabled");});
 const route=await h.entry("app/api/speech/route.ts"),response=await route.POST(new Request("https://app.example/api/speech",{method:"POST",body:JSON.stringify({voiceId:"publicVietnamese",duration:5,segments:[{start:0,end:5,text:"Xin chào bạn."}]})}));
 assert.equal(response.status,503);assert.equal((await response.json()).code,"VOICE_PRICING_UNAVAILABLE");assert.equal(h.charged.length,0);assert.equal(h.media.size,0);assert.equal(h.requests.length,0);
});
await check("premade voices remain usable without fetching subscription information",async()=>{
 const h=await harness();h.grant(alice,"premadeVoice");
 h.setHandler(request=>{
  if(isCatalog(request))return Response.json({voices:[]});
  assert.ok(request.url.endsWith("/voices/premadeVoice"));return Response.json({voice_id:"premadeVoice",category:"premade"});
 });
 assert.equal(await h.eleven.authorizeVoice(alice,"premadeVoice"),"premadeVoice");assert.ok(h.requests.every(request=>!request.url.endsWith("/user/subscription")));assert.equal(h.charged.length,0);
});
console.log(`${passed} isolated voice catalog and entitlement tests passed.`);
