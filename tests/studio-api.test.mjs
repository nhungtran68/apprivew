import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Offline integration tests. All Supabase and AI network requests are replaced with explicit fakes.
const root=process.cwd(), alice="11111111-1111-4111-8111-111111111111", bob="22222222-2222-4222-8222-222222222222";
const environment={NEXT_PUBLIC_SUPABASE_URL:"https://offline.supabase.invalid",NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:"offline-public",DEEPSEEK_API_KEY:"offline-deepseek",ELEVENLABS_API_KEY:"offline-eleven",STUDIO_ENCRYPTION_KEY:"offline-signing-secret-do-not-use-in-production"};
const members=new Map([[alice,{user_id:alice,email:"alice@example.invalid",display_name:"Alice",role:"member",enabled:true,ai_units_limit:1000,ai_units_used:0}],[bob,{user_id:bob,email:"bob@example.invalid",display_name:"Bob",role:"member",enabled:true,ai_units_limit:1000,ai_units_used:0}]]),profiles=new Map(),voices=new Map(),media=new Map();
let identity=alice, requestFetch=async()=>{throw new Error("Unexpected outbound request");}, charged=[];
function query(table){let filters=[],action="select",values;const builder={select(){return this;},eq(key,value){filters.push([key,value]);return this;},order(){return this;},limit(){return this;},update(data){action="update";values=data;return this;},upsert(data){action="upsert";values=data;return this;},maybeSingle(){return run(true);},then(resolve,reject){return run(false).then(resolve,reject);}};
async function run(single){const map=table==="studio_members"?members:table==="studio_settings"?profiles:voices;
if(action==="upsert"){for(const row of Array.isArray(values)?values:[values]){if(row.user_id!==identity)return{data:null,error:{message:"RLS"}};map.set(table==="studio_voices"?`${row.user_id}:${row.voice_id}`:row.user_id,row);}return{data:null,error:null};}
let rows=[...map.values()].filter(row=>(row.user_id===identity||(table==="studio_members"&&members.get(identity)?.role==="admin"))&&filters.every(([k,v])=>row[k]===v));
if(action==="update"){if(members.get(identity)?.role!=="admin")return{data:null,error:{message:"RLS"}};rows=rows.map(row=>{Object.assign(row,values);return row;});}
return{data:single?rows[0]||null:rows,error:null};}return builder;}
const fakeClient={auth:{async getUser(){return{data:{user:identity?{id:identity,email:members.get(identity)?.email}:null},error:null};}},from:query,async rpc(name,args){assert.equal(name,"consume_studio_ai_units");const member=members.get(identity);if(!member?.enabled)return{error:{message:"MEMBER_DISABLED"}};if(member.ai_units_used+args.p_units>member.ai_units_limit)return{error:{message:"QUOTA_EXCEEDED"}};member.ai_units_used+=args.p_units;charged.push(args.p_units);return{data:member.ai_units_limit-member.ai_units_used,error:null};},storage:{from(bucket){assert.equal(bucket,"studio-media");return{async upload(name,data){media.set(name,data);return{error:null};},async createSignedUrl(name){return{data:{signedUrl:`https://offline.supabase.invalid/private/${name}?token=offline`},error:null};},async remove(paths){paths.forEach(p=>media.delete(p));return{error:null};},async download(name){return{data:media.get(name)||null,error:media.has(name)?null:{message:"missing"}};}};}}};
const context=vm.createContext({console,crypto,process:{env:environment},TextEncoder,TextDecoder,Uint8Array,DataView,ArrayBuffer,FormData,File,Request,Response,Headers,URL,AbortSignal,TransformStream,setTimeout,clearTimeout,btoa,atob,fetch:(...args)=>requestFetch(...args)}),modules=new Map();
async function load(file){if(modules.has(file))return modules.get(file);const code=ts.transpileModule(await fs.readFile(file,"utf8"),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;const mod=new vm.SourceTextModule(code,{context,identifier:file});modules.set(file,mod);return mod;}
const synthetic=new Map();
async function linker(specifier,parent){
 if(["server-only","@supabase/ssr","next/headers"].includes(specifier)){
  if(synthetic.has(specifier))return synthetic.get(specifier);
  const exports=specifier==="server-only"?[]:specifier==="@supabase/ssr"?["createServerClient"]:["cookies"];
  const mod=new vm.SyntheticModule(exports,function(){if(specifier==="@supabase/ssr")this.setExport("createServerClient",()=>fakeClient);if(specifier==="next/headers")this.setExport("cookies",async()=>({getAll:()=>[],set:()=>{}}));},{context});synthetic.set(specifier,mod);return mod;
 }
 return load(specifier.startsWith("@/")?path.join(root,specifier.slice(2))+".ts":path.resolve(path.dirname(parent.identifier),specifier)+".ts");
}
const top=await load(path.join(root,"lib/studio-eleven.ts"));await top.link(linker);await top.evaluate();
const contract=modules.get(path.join(root,"lib/studio-contract.ts")).namespace,server=modules.get(path.join(root,"lib/studio-server.ts")).namespace,deepseek=modules.get(path.join(root,"lib/studio-deepseek.ts")).namespace,eleven=top.namespace,supabase=modules.get(path.join(root,"lib/studio-supabase.ts")).namespace;
let passed=0;async function check(name,run){if(process.env.STUDIO_TEST_FILTER&&!name.includes(process.env.STUDIO_TEST_FILTER))return;identity=alice;charged=[];await run();console.log(`PASS ${name}`);passed++;}
const frame={time:0,image:"data:image/jpeg;base64,/9j/AA=="};
await check("rejects overlapping timeline and preserves exact WAV samples",()=>{assert.throws(()=>contract.validateSegments([{start:0,end:3,text:"a"},{start:2,end:4,text:"b"}],5));assert.throws(()=>contract.validDuration(91));const pcm=new Uint8Array(96000).fill(7),wav=contract.pcmToWav(pcm);assert.equal(wav.length,96044);assert.equal(wav[44],7);assert.equal(new DataView(wav.buffer).getUint32(24,true),24000);});
await check("validates Supabase identity rather than forged user headers",async()=>{identity=null;await assert.rejects(server.requestUser(new Request("https://app.example/api/config",{headers:{"oai-authenticated-user-id":alice}})),{code:"SIGN_IN_REQUIRED"});identity=alice;members.get(alice).enabled=false;await assert.rejects(server.requestUser(new Request("https://app.example/api/config")),{code:"MEMBER_DISABLED"});members.get(alice).enabled=true;assert.equal(await server.requestUser(new Request("https://app.example/api/config")),alice);});
await check("rejects foreign origins and missing configuration",async()=>{await assert.rejects(server.requestUser(new Request("https://app.example/api/settings",{method:"POST",headers:{origin:"https://evil.example"}}),true),{code:"INVALID_ORIGIN"});const key=environment.NEXT_PUBLIC_SUPABASE_URL;delete environment.NEXT_PUBLIC_SUPABASE_URL;await assert.rejects(supabase.createStudioSupabaseServer(),{code:"AUTH_NOT_CONFIGURED"});environment.NEXT_PUBLIC_SUPABASE_URL=key;});
await check("shared keys never returned or written by member settings",async()=>{const config=await server.getConfig(alice);assert.equal(config.deepseekConfigured,true);assert.ok(!JSON.stringify(config).includes("offline-deepseek"));await assert.rejects(server.saveSettings(alice,{deepseekApiKey:"private"}),{code:"SHARED_KEYS_MANAGED"});await server.saveSettings(alice,{profile:{name:"Alice",tone:"Tự nhiên",mode:"face",secret:"drop"}});assert.equal(profiles.get(alice).profile_json.mode,"face");assert.equal(profiles.get(alice).profile_json.secret,undefined);});
await check("saved profile name is returned as account display name",async()=>{const config=await server.getConfig(alice);assert.equal(config.memberName,"Alice");});
await check("quota exhaustion blocks provider requests before network",async()=>{const member=members.get(alice),limit=member.ai_units_limit;member.ai_units_limit=member.ai_units_used;let requests=0;requestFetch=async()=>{requests++;throw new Error("must not call");};await assert.rejects(deepseek.deepseekJson("offline","json",{text:"x"},()=>server.consumeAiUnits(alice,1)),{code:"QUOTA_EXCEEDED"});assert.equal(requests,0);member.ai_units_limit=limit;});
await check("sampled frame contract rejects remote URLs and invalid timestamps",()=>{assert.equal(deepseek.validateFrames([frame],5).length,1);assert.throws(()=>deepseek.validateFrames([{time:0,image:"https://example.com/image.jpg"}],5));assert.throws(()=>deepseek.validateFrames([frame,frame],5));assert.throws(()=>deepseek.validateFrames([{...frame,time:6}],5));assert.throws(()=>deepseek.validateFrames([{...frame,image:frame.image+"A".repeat(160000)}],5));});
await check("DeepSeek vision request is JSON and declares sampling/audio limits",async()=>{let payload;requestFetch=async(url,init)=>{assert.equal(url,"https://api.deepseek.com/chat/completions");payload=JSON.parse(init.body);return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({summary:"Vườn",intentSummary:"Niềm vui",observations:[{start:0,end:5,description:"Ảnh vườn"}],facts:[],unknowns:[],questions:[]})}}]});};const result=await deepseek.analyzeFrames("offline",{frames:[frame],duration:5,intent:"Chia sẻ niềm vui",profile:{mode:"talking"},transcript:""},()=>server.consumeAiUnits(alice,1));assert.equal(payload.model,"deepseek-flash");assert.equal(payload.response_format.type,"json_object");assert.equal(payload.thinking.type,"disabled");assert.equal(payload.messages[1].content.at(-1).type,"image_url");assert.match(payload.messages[1].content[0].text,/KHÔNG nhận âm thanh/);assert.match(result.samplingNote,/ảnh mẫu/);assert.deepEqual(charged,[1]);});
await check("all scenery, talking and face modes preserve supplied intent and declare source limitations",async()=>{
 const modeCases=[
  {mode:"scenery",constraint:/Không tự suy ra ý muốn chia sẻ từ hình ảnh/},
  {mode:"talking",constraint:/Giữ ý bản chép, không suy đoán lời nói từ hình/},
  {mode:"face",constraint:/không đọc môi, không suy đoán quan điểm người trong hình/},
 ];
 const supplied="Tôi muốn kể niềm vui khi thấy chùm nho đầu tiên, không giới thiệu giá bán.";
 for(const {mode,constraint} of modeCases){
  let analysis;
  for(const transcript of [supplied,""]){
   let payload;
   requestFetch=async(url,init)=>{
    assert.equal(url,"https://api.deepseek.com/chat/completions");payload=JSON.parse(init.body);
    return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({summary:"Một chùm nho trong ảnh",intentSummary:supplied,observations:[{start:0,end:5,description:"Chùm nho nhìn thấy trong ảnh mẫu"}],facts:[],unknowns:[],questions:[],transcript:"Provider tự bịa rằng người quay nói giá 999 nghìn.",generatedTranscript:"Provider tự bịa lời nói gốc."})}}]});
   };
   analysis=await deepseek.analyzeFrames("offline",{frames:[frame],duration:5,intent:supplied,profile:{mode},transcript},()=>server.consumeAiUnits(alice,1));
   const prompt=payload.messages[1].content[0].text;
   assert.match(prompt,constraint,`${mode} analysis must carry its mode constraint`);
   assert.match(prompt,/KHÔNG nhận âm thanh/);
   assert.match(prompt,/Bản chép bên dưới do người dùng cung cấp, chưa được xác minh bằng âm thanh/);
   assert.ok(prompt.includes(`Ý muốn chia sẻ: ${JSON.stringify(supplied)}`));
   assert.ok(prompt.includes(`Bản chép\/lời dặn: ${JSON.stringify(transcript)}`));
   assert.equal(payload.messages[1].content.filter(part=>part.type==="image_url").length,1);
   assert.equal(payload.messages[1].content.some(part=>part.type==="input_audio"||part.type==="audio"||part.type==="video"),false);
   assert.equal(analysis.transcript,undefined,"provider-generated transcript must not become original speech");
   assert.equal(analysis.generatedTranscript,undefined,"untrusted provider extensions must not be promoted into source facts");
   assert.match(analysis.samplingNote,/không nghe âm thanh gốc/);
   if(mode==="face"){assert.match(prompt,/không đọc môi/);assert.match(prompt,/không đồng bộ khẩu hình/);}
  }
  let scriptPayload;
  requestFetch=async(url,init)=>{assert.equal(url,"https://api.deepseek.com/chat/completions");scriptPayload=JSON.parse(init.body);return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({title:"Chùm nho đầu tiên",intentSummary:supplied,segments:[{start:0,end:5,text:"Thật vui khi thấy chùm nho đầu tiên trong vườn."}]})}}]});};
  const script=await deepseek.createScript("offline",{analysis,intent:supplied,profile:{mode},duration:5,instruction:"Giữ câu chuyện riêng của tôi."},()=>server.consumeAiUnits(alice,1));
  const scriptPrompt=scriptPayload.messages[1].content[0].text;
  assert.match(scriptPrompt,constraint,`${mode} script must carry the same mode constraint`);
  assert.match(scriptPrompt,/Phân tích chỉ dựa ảnh mẫu, không khẳng định sự kiện giữa ảnh hoặc lời nói gốc/);
  assert.ok(scriptPrompt.includes(`Ý muốn chia sẻ: ${JSON.stringify(supplied)}`));
  assert.ok(!scriptPrompt.includes("Provider tự bịa"),"discarded provider transcripts must not leak into script context");
  if(mode==="talking"||mode==="face")assert.match(scriptPrompt,/KHÔNG nhận âm thanh gốc/);
  if(mode==="face")assert.match(scriptPrompt,/không đồng bộ khẩu hình/);
  assert.equal(script.segments[0].end,5);
  assert.equal(scriptPayload.messages[1].content.some(part=>part.type==="image_url"),false,"the script step should reuse verified analysis rather than resending images");
 }
 assert.equal(charged.length,9,"three offline provider requests per mode must each consume one unit");
});
await check("shared voice list hides other members clones and forged ownership",async()=>{await server.saveAuthorizedVoice(alice,"voiceAlice123","Alice","personal");const own=voices.get(`${alice}:voiceAlice123`);identity=bob;voices.set(`${bob}:voiceAlice123`,{...own,user_id:bob});await assert.rejects(eleven.authorizeVoice(bob,"voiceAlice123"),{code:"VOICE_NOT_AUTHORIZED"});identity=alice;requestFetch=async()=>Response.json({voices:[{voice_id:"voiceAlice123",name:"Alice",category:"cloned"},{voice_id:"victimVoice123",name:"Victim",category:"cloned"},{voice_id:"premadeVoice123",name:"Sample",category:"premade"}]});const list=await eleven.listVoices("offline",alice);assert.equal(list.length,2);assert.ok(!list.some(v=>v.voiceId==="victimVoice123"));});
await check("speech retries consume units and return signed WAV references",async()=>{let synths=0;requestFetch=async(url)=>{if(String(url).includes("elevenlabs")){synths++;return new Response(new Uint8Array(synths===1?144000:86400));}return Response.json({choices:[{message:{content:JSON.stringify({text:"Câu ngắn hơn."})},finish_reason:"stop"}]});};const result=await eleven.generateSpeech({key:"offline",userId:alice,voiceId:"voiceAlice123",duration:5,segments:[{start:1,end:3,text:"Đây là câu hiện quá dài."}]});assert.equal(synths,2);assert.equal(charged.length,3);assert.equal(result.segments[0].duration,1.8);assert.equal(result.segments[0].audioBase64,undefined);assert.ok(result.segments[0].audioUrl.startsWith("https://offline.supabase.invalid/"));assert.equal(media.get(result.segments[0].audioPath).length,86444);});
await check("failed timing preserves speech and blocks final export",async()=>{let synths=0;requestFetch=async(url)=>String(url).includes("elevenlabs")?(synths++,new Response(new Uint8Array(144000))):Response.json({choices:[{message:{content:JSON.stringify({text:"Vẫn quá dài"})}}]});await assert.rejects(eleven.generateSpeech({key:"offline",userId:alice,voiceId:"voiceAlice123",duration:5,segments:[{start:0,end:2,text:"Câu đầu"}]}),{code:"TIMING_NEEDS_EDIT"});assert.equal(synths,3);});
await check("admin member changes require role and validate quota",async()=>{await assert.rejects(server.listMembers(alice),{code:"ADMIN_REQUIRED"});members.get(alice).role="admin";const changed=await server.updateMember(alice,{userId:bob,enabled:true,aiUnitsLimit:50,resetUsage:true});assert.equal(changed.ai_units_limit,50);assert.equal(changed.ai_units_used,0);await assert.rejects(server.updateMember(alice,{userId:bob,aiUnitsLimit:-1}),{code:"INVALID_QUOTA"});members.get(alice).role="member";});
await check("media paths cannot access another member or traverse directories",()=>{assert.equal(supabase.assertOwnedMediaPath(alice,`${alice}/samples/voice.wav`),`${alice}/samples/voice.wav`);assert.throws(()=>supabase.assertOwnedMediaPath(alice,`${bob}/samples/voice.wav`));assert.throws(()=>supabase.assertOwnedMediaPath(alice,`${alice}/../victim.wav`));});
await check("JSON streaming enforces Vercel-safe body bound",async()=>{const request=new Request("https://app.example/api/analyze",{method:"POST",body:JSON.stringify({value:"x".repeat(500)})});await assert.rejects(server.limitedJson(request,100),{code:"PAYLOAD_TOO_LARGE"});});
await check("SQL setup limits member writes, owns storage and exposes no refund",async()=>{const sql=await fs.readFile(path.join(root,"supabase/setup.sql"),"utf8");assert.match(sql,/where user_id=auth\.uid\(\) and enabled and ai_units_used\+p_units<=ai_units_limit/);assert.match(sql,/grant update \(enabled,ai_units_limit,ai_units_used,updated_at\)/);assert.ok(!/grant update \([^)]*role/.test(sql));assert.match(sql,/authorization_tag text not null/);assert.match(sql,/alter table public\.studio_members enable row level security/);assert.match(sql,/language sql security invoker/);assert.ok(!/create[^;]*function[^;]*(refund|settle)/i.test(sql));});
console.log(`${passed} offline backend behavior tests passed.`);
