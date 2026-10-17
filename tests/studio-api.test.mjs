import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import ts from "typescript";

// Offline integration tests. All Supabase and AI network requests are replaced with explicit fakes.
const root=process.cwd(), alice="11111111-1111-4111-8111-111111111111", bob="22222222-2222-4222-8222-222222222222";
const environment={NEXT_PUBLIC_SUPABASE_URL:"https://offline.supabase.invalid",NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY:"offline-public",DEEPSEEK_API_KEY:"offline-deepseek",ELEVENLABS_API_KEY:"offline-eleven",STUDIO_ENCRYPTION_KEY:"offline-signing-secret-do-not-use-in-production"};
const members=new Map([[alice,{user_id:alice,email:"alice@example.invalid",display_name:"Alice",role:"member",enabled:true,ai_units_limit:1000,ai_units_used:0}],[bob,{user_id:bob,email:"bob@example.invalid",display_name:"Bob",role:"member",enabled:true,ai_units_limit:1000,ai_units_used:0}]]),profiles=new Map(),voices=new Map(),media=new Map();
let identity=alice, requestFetch=async()=>{throw new Error("Unexpected outbound request");}, charged=[], usageLogs=[];
function query(table){let filters=[],action="select",values;const builder={select(){return this;},eq(key,value){filters.push([key,value]);return this;},order(){return this;},limit(){return this;},update(data){action="update";values=data;return this;},upsert(data){action="upsert";values=data;return this;},maybeSingle(){return run(true);},then(resolve,reject){return run(false).then(resolve,reject);}};
async function run(single){const map=table==="studio_members"?members:table==="studio_settings"?profiles:voices;
if(action==="upsert"){for(const row of Array.isArray(values)?values:[values]){if(row.user_id!==identity)return{data:null,error:{message:"RLS"}};map.set(table==="studio_voices"?`${row.user_id}:${row.voice_id}`:row.user_id,row);}return{data:null,error:null};}
let rows=[...map.values()].filter(row=>(row.user_id===identity||(table==="studio_members"&&members.get(identity)?.role==="admin"))&&filters.every(([k,v])=>row[k]===v));
if(action==="update"){if(members.get(identity)?.role!=="admin")return{data:null,error:{message:"RLS"}};rows=rows.map(row=>{Object.assign(row,values);return row;});}
return{data:single?rows[0]||null:rows,error:null};}return builder;}
const fakeClient={auth:{async getUser(){return{data:{user:identity?{id:identity,email:members.get(identity)?.email}:null},error:null};}},from:query,async rpc(name,args){assert.equal(name,"consume_studio_ai_units");const member=members.get(identity);if(!member?.enabled)return{error:{message:"MEMBER_DISABLED"}};if(member.ai_units_used+args.p_units>member.ai_units_limit)return{error:{message:"QUOTA_EXCEEDED"}};member.ai_units_used+=args.p_units;charged.push(args.p_units);return{data:member.ai_units_limit-member.ai_units_used,error:null};},storage:{from(bucket){assert.equal(bucket,"studio-media");return{async upload(name,data){media.set(name,data);return{error:null};},async createSignedUrl(name){return{data:{signedUrl:`https://offline.supabase.invalid/private/${name}?token=offline`},error:null};},async remove(paths){paths.forEach(p=>media.delete(p));return{error:null};},async download(name){return{data:media.get(name)||null,error:media.has(name)?null:{message:"missing"}};}};}}};
const context=vm.createContext({console:{...console,info:(...values)=>usageLogs.push(values)},crypto,process:{env:environment},TextEncoder,TextDecoder,Uint8Array,DataView,ArrayBuffer,FormData,File,Request,Response,Headers,URL,AbortSignal,TransformStream,setTimeout,clearTimeout,btoa,atob,fetch:(...args)=>requestFetch(...args)}),modules=new Map();
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
let passed=0;async function check(name,run){if(process.env.STUDIO_TEST_FILTER&&!name.includes(process.env.STUDIO_TEST_FILTER))return;identity=alice;charged=[];usageLogs=[];await run();console.log(`PASS ${name}`);passed++;}
const frame={time:0,image:"data:image/jpeg;base64,/9j/AA=="};
await check("rejects overlapping timeline and preserves exact WAV samples",()=>{assert.throws(()=>contract.validateSegments([{start:0,end:3,text:"a"},{start:2,end:4,text:"b"}],5));assert.throws(()=>contract.validDuration(91));const pcm=new Uint8Array(96000).fill(7),wav=contract.pcmToWav(pcm);assert.equal(wav.length,96044);assert.equal(wav[44],7);assert.equal(new DataView(wav.buffer).getUint32(24,true),24000);});
await check("validates Supabase identity rather than forged user headers",async()=>{identity=null;await assert.rejects(server.requestUser(new Request("https://app.example/api/config",{headers:{"oai-authenticated-user-id":alice}})),{code:"SIGN_IN_REQUIRED"});identity=alice;members.get(alice).enabled=false;await assert.rejects(server.requestUser(new Request("https://app.example/api/config")),{code:"MEMBER_DISABLED"});members.get(alice).enabled=true;assert.equal(await server.requestUser(new Request("https://app.example/api/config")),alice);});
await check("rejects foreign origins and missing configuration",async()=>{await assert.rejects(server.requestUser(new Request("https://app.example/api/settings",{method:"POST",headers:{origin:"https://evil.example"}}),true),{code:"INVALID_ORIGIN"});const key=environment.NEXT_PUBLIC_SUPABASE_URL;delete environment.NEXT_PUBLIC_SUPABASE_URL;await assert.rejects(supabase.createStudioSupabaseServer(),{code:"AUTH_NOT_CONFIGURED"});environment.NEXT_PUBLIC_SUPABASE_URL=key;});
await check("shared keys never returned or written by member settings",async()=>{const config=await server.getConfig(alice);assert.equal(config.deepseekConfigured,true);assert.ok(!JSON.stringify(config).includes("offline-deepseek"));await assert.rejects(server.saveSettings(alice,{deepseekApiKey:"private"}),{code:"SHARED_KEYS_MANAGED"});await server.saveSettings(alice,{profile:{name:"Alice",tone:"Tự nhiên",mode:"face",secret:"drop"}});assert.equal(profiles.get(alice).profile_json.mode,"face");assert.equal(profiles.get(alice).profile_json.secret,undefined);});
await check("provider machine codes give actionable errors without exposing provider content",async()=>{
 const fakeSecret="sk-offline-malicious-provider-message-do-not-expose",cases=[
  {provider:"ElevenLabs",http:422,status:"api_key_id_used_as_api_key",code:"PROVIDER_KEY_ID",responseStatus:422,hint:/Key ID.*Secret API key/},
  {provider:"ElevenLabs",http:401,status:"invalid_api_key",code:"PROVIDER_AUTH",responseStatus:422,hint:/khóa API/},
  {provider:"ElevenLabs",http:403,status:"missing_permissions",code:"PROVIDER_PERMISSION",responseStatus:422,hint:/Voices: Read.*Text to Speech/},
  {provider:"ElevenLabs",http:403,status:"missing_permissions",permission:"voices_read",code:"PROVIDER_PERMISSION",responseStatus:422,hint:/khóa ElevenLabs đang kết nối.*Voices: Read.*lưu/i},
  {provider:"ElevenLabs",http:403,status:"missing_permissions",permission:"voices_write",code:"PROVIDER_PERMISSION",responseStatus:422,hint:/khóa ElevenLabs đang kết nối.*tạo giọng cá nhân.*Voices: Write.*lưu/i},
  {provider:"ElevenLabs",http:403,status:"missing_permissions",permission:"text_to_speech",code:"PROVIDER_PERMISSION",responseStatus:422,hint:/khóa ElevenLabs đang kết nối.*tạo lời đọc.*Text to Speech.*lưu/i},
  {provider:"ElevenLabs",http:400,status:"quota_exceeded",code:"PROVIDER_LIMIT",responseStatus:429,hint:/hạn mức/},
  {provider:"DeepSeek",http:402,status:"irrelevant",code:"PROVIDER_BALANCE",responseStatus:422,hint:/số dư/},
 ];
 for(const item of cases){
  const response=Response.json({detail:{status:item.status,message:`Sensitive provider message ${fakeSecret}`,required_permissions:[fakeSecret]},error:{message:fakeSecret}},{status:item.http});
  let caught;
  await assert.rejects(server.providerResponse(response,item.provider,item.permission),error=>{caught=error;assert.equal(error.code,item.code);assert.match(error.message,item.hint);return true;});
  const publicResponse=server.apiError(caught),body=await publicResponse.json();
  assert.equal(publicResponse.status,item.responseStatus);assert.equal(body.action,"contact_admin");assert.equal(body.code,item.code);
  assert.ok(!JSON.stringify(body).includes(fakeSecret));assert.ok(!JSON.stringify(body).includes("Sensitive provider message"));assert.equal(response.body.locked,false);
 }
});
await check("provider classification requires exact codes and preserves generic HTTP errors",async()=>{
 const cases=[
  {provider:"ElevenLabs",http:422,body:{detail:{status:"unknown",message:"api_key_id_used_as_api_key invalid_api_key missing_permissions quota_exceeded"}},code:"PROVIDER_REJECTED",responseStatus:422},
  {provider:"ElevenLabs",http:422,body:{detail:{status:"api_key_id_used_as_api_key_extra"}},code:"PROVIDER_REJECTED",responseStatus:422},
  {provider:"ElevenLabs",http:422,body:{detail:[{status:"api_key_id_used_as_api_key"}]},code:"PROVIDER_REJECTED",responseStatus:422},
  {provider:"DeepSeek",http:422,body:{detail:{status:"api_key_id_used_as_api_key"}},code:"PROVIDER_REJECTED",responseStatus:422},
  {provider:"ElevenLabs",http:401,body:{},code:"PROVIDER_AUTH",responseStatus:422},
  {provider:"ElevenLabs",http:429,body:{},code:"PROVIDER_LIMIT",responseStatus:429},
  {provider:"ElevenLabs",http:500,body:{},code:"PROVIDER_UNAVAILABLE",responseStatus:502},
 ];
 for(const item of cases)await assert.rejects(server.providerResponse(Response.json(item.body,{status:item.http}),item.provider),{code:item.code,status:item.responseStatus});
 await assert.rejects(server.providerResponse(new Response("not-json sk-offline-error-body",{status:422}),"ElevenLabs"),{code:"PROVIDER_REJECTED"});
 const success=new Response("untouched audio",{status:200});assert.equal(await server.providerResponse(success,"ElevenLabs"),success);assert.equal(success.bodyUsed,false);
});
await check("oversized provider errors are cancelled and never classified from a partial prefix",async()=>{
 const encoder=new TextEncoder(),prefix=JSON.stringify({detail:{status:"api_key_id_used_as_api_key",message:"sk-offline-oversized-secret"}}),body=encoder.encode(prefix+" ".repeat(32*1024));
 for(const declaredLength of [undefined,String(32*1024+1)]){
  let cancelled=false;
  const stream=new ReadableStream({start(controller){controller.enqueue(body);},cancel(){cancelled=true;}});
  const response=new Response(stream,{status:422,headers:declaredLength?{"content-length":declaredLength}:undefined});
  await assert.rejects(server.providerResponse(response,"ElevenLabs"),{code:"PROVIDER_REJECTED"});assert.equal(cancelled,true);assert.equal(response.body.locked,false);
 }
 const broken=new ReadableStream({start(controller){controller.error(new Error("sk-offline-stream-secret"));}});
 await assert.rejects(server.providerResponse(new Response(broken,{status:403}),"ElevenLabs"),{code:"PROVIDER_AUTH"});
});
await check("model configuration never exposes a credential accidentally pasted into model fields",async()=>{
 const previousDeepseek=environment.DEEPSEEK_MODEL,previousEleven=environment.ELEVENLABS_MODEL;
 const misplacedDeepseek="sk-offline-model-field-secret-do-not-use",misplacedEleven="a".repeat(64);
 try{
  environment.DEEPSEEK_MODEL=misplacedDeepseek;environment.ELEVENLABS_MODEL=misplacedEleven;
  const config=await server.getConfig(alice),serialized=JSON.stringify(config);
  assert.equal(config.deepseekModel,"deepseek-flash");assert.equal(config.voiceModel,"eleven_flash_v2_5");
  assert.ok(!serialized.includes(misplacedDeepseek));assert.ok(!serialized.includes(misplacedEleven));
  assert.equal(config.deepseekConfigured,true);assert.equal(config.elevenConfigured,true);
 }finally{
  if(previousDeepseek===undefined)delete environment.DEEPSEEK_MODEL;else environment.DEEPSEEK_MODEL=previousDeepseek;
  if(previousEleven===undefined)delete environment.ELEVENLABS_MODEL;else environment.ELEVENLABS_MODEL=previousEleven;
 }
});
await check("only approved vision and Vietnamese speech model IDs are accepted",()=>{
 const previousDeepseek=environment.DEEPSEEK_MODEL,previousEleven=environment.ELEVENLABS_MODEL;
 try{
  environment.DEEPSEEK_MODEL="deepseek-flash";
  for(const model of ["eleven_flash_v2_5","eleven_turbo_v2_5","eleven_v3","eleven_v4"]){environment.ELEVENLABS_MODEL=model;assert.equal(server.modelNames().deepseekModel,"deepseek-flash");assert.equal(server.modelNames().voiceModel,model);}
  for(const model of ["deepseek-v4-pro","deepseek-chat","unknown-model",""]){environment.DEEPSEEK_MODEL=model;assert.equal(server.modelNames().deepseekModel,"deepseek-flash");}
  for(const model of ["eleven_flash_v2","eleven_multilingual_v2","eleven_text_to_sound_v2","unknown-model",""]){environment.ELEVENLABS_MODEL=model;assert.equal(server.modelNames().voiceModel,"eleven_flash_v2_5");}
 }finally{
  if(previousDeepseek===undefined)delete environment.DEEPSEEK_MODEL;else environment.DEEPSEEK_MODEL=previousDeepseek;
  if(previousEleven===undefined)delete environment.ELEVENLABS_MODEL;else environment.ELEVENLABS_MODEL=previousEleven;
 }
});
await check("provider requests use safe default model IDs after model-field secret misconfiguration",async()=>{
 const previousDeepseek=environment.DEEPSEEK_MODEL,previousEleven=environment.ELEVENLABS_MODEL;
 const misplacedDeepseek="sk-offline-model-payload-secret-do-not-use",misplacedEleven="b".repeat(64),requests=[];
 let speech;
 try{
  environment.DEEPSEEK_MODEL=misplacedDeepseek;environment.ELEVENLABS_MODEL=misplacedEleven;
  requestFetch=async(url,init)=>{
   const body=JSON.parse(init.body);requests.push({url:String(url),body});
   if(String(url)==="https://api.deepseek.com/chat/completions")return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({text:"offline response"})}}]});
   assert.ok(String(url).startsWith("https://api.elevenlabs.io/v1/text-to-speech/"));
   return new Response(new Uint8Array(48000));
  };
  await deepseek.deepseekJson("offline","json",{text:"offline"},()=>server.consumeAiUnits(alice,1));
  speech=await eleven.generateSpeech({key:"offline",userId:alice,voiceId:"offlineVoice123",duration:5,segments:[{start:0,end:2,text:"Offline speech"}]});
  assert.equal(requests.length,2);assert.equal(requests[0].body.model,"deepseek-flash");assert.equal(requests[1].body.model_id,"eleven_flash_v2_5");
  const serialized=JSON.stringify(requests);assert.ok(!serialized.includes(misplacedDeepseek));assert.ok(!serialized.includes(misplacedEleven));assert.deepEqual(charged,[1,1]);
 }finally{
  if(speech)await supabase.removeOwnedMedia(alice,speech.segments.map(segment=>segment.audioPath));
  if(previousDeepseek===undefined)delete environment.DEEPSEEK_MODEL;else environment.DEEPSEEK_MODEL=previousDeepseek;
  if(previousEleven===undefined)delete environment.ELEVENLABS_MODEL;else environment.ELEVENLABS_MODEL=previousEleven;
 }
});
await check("saved profile name is returned as account display name",async()=>{const config=await server.getConfig(alice);assert.equal(config.memberName,"Alice");});
await check("quota exhaustion blocks provider requests before network",async()=>{const member=members.get(alice),limit=member.ai_units_limit;member.ai_units_limit=member.ai_units_used;let requests=0;requestFetch=async()=>{requests++;throw new Error("must not call");};await assert.rejects(deepseek.deepseekJson("offline","json",{text:"x"},()=>server.consumeAiUnits(alice,1)),{code:"QUOTA_EXCEEDED"});assert.equal(requests,0);member.ai_units_limit=limit;});
await check("sampled frame contract rejects remote URLs and invalid timestamps",()=>{assert.equal(deepseek.validateFrames([frame],5).length,1);assert.throws(()=>deepseek.validateFrames([{time:0,image:"https://example.com/image.jpg"}],5));assert.throws(()=>deepseek.validateFrames([frame,frame],5));assert.throws(()=>deepseek.validateFrames([{...frame,time:6}],5));assert.throws(()=>deepseek.validateFrames([{...frame,image:frame.image+"A".repeat(160000)}],5));});
await check("DeepSeek vision request is JSON and declares sampling/audio limits",async()=>{let payload;requestFetch=async(url,init)=>{assert.equal(url,"https://api.deepseek.com/chat/completions");payload=JSON.parse(init.body);return Response.json({choices:[{finish_reason:"stop",message:{content:JSON.stringify({summary:"Vườn",intentSummary:"Niềm vui",observations:[{start:0,end:5,description:"Ảnh vườn"}],facts:[],unknowns:[],questions:[]})}}]});};const result=await deepseek.analyzeFrames("offline",{frames:[frame],duration:5,intent:"Chia sẻ niềm vui",profile:{mode:"talking"},transcript:""},()=>server.consumeAiUnits(alice,1));assert.equal(payload.model,"deepseek-flash");assert.equal(payload.response_format.type,"json_object");assert.equal(payload.thinking.type,"disabled");assert.equal(payload.messages[1].content.at(-1).type,"image_url");assert.match(payload.messages[1].content[0].text,/KHÔNG nhận âm thanh/);assert.match(result.samplingNote,/ảnh mẫu/);assert.deepEqual(charged,[1]);});
await check("DeepSeek usage logs allow only bounded numeric counters and exclude sensitive content",async()=>{
 const sensitive="sk-offline-sensitive-prompt-and-provider-content",requestKey="sk-offline-private-request-key",allNull={prompt_cache_hit_tokens:null,prompt_cache_miss_tokens:null,completion_tokens:null,reasoning_tokens:null};
 const cases=[
  {usage:{prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:2000000,completion_tokens:19,completion_tokens_details:{reasoning_tokens:11,private:sensitive},prompt:sensitive,extra:sensitive},finish:"stop",expected:{prompt_cache_hit_tokens:0,prompt_cache_miss_tokens:2000000,completion_tokens:19,reasoning_tokens:11}},
  {usage:{prompt_cache_hit_tokens:-1,prompt_cache_miss_tokens:"12",completion_tokens:2000001,reasoning_tokens:999,completion_tokens_details:{reasoning_tokens:0.5},extra:sensitive},finish:sensitive,expected:allNull},
  {usage:[sensitive],finish:undefined,expected:allNull},
 ];
 for(const item of cases){
  usageLogs=[];
  requestFetch=async()=>Response.json({model:sensitive,usage:item.usage,private:sensitive,choices:[{finish_reason:item.finish,message:{content:JSON.stringify({text:sensitive})}}]});
  await deepseek.deepseekJson(requestKey,`Private prompt ${sensitive}`,{private:sensitive},()=>server.consumeAiUnits(alice,1),[frame]);
  assert.equal(usageLogs.length,1);assert.equal(usageLogs[0].length,1);assert.equal(typeof usageLogs[0][0],"string");
  const line=usageLogs[0][0],entry=JSON.parse(line);
  assert.deepEqual(Object.keys(entry).sort(),["event","model","thinking","elapsedMs","usage","finish_reason"].sort());
  assert.equal(entry.event,"studio_ai_usage");assert.equal(entry.model,"deepseek-flash");assert.equal(entry.thinking,"disabled");
  assert.ok(entry.elapsedMs===null||(Number.isSafeInteger(entry.elapsedMs)&&entry.elapsedMs>=0&&entry.elapsedMs<=3600000));
  assert.deepEqual(entry.usage,item.expected);assert.equal(entry.finish_reason,item.finish==="stop"?"stop":null);
  assert.ok(!line.includes(sensitive));assert.ok(!line.includes(requestKey));assert.ok(!line.includes(frame.image));assert.ok(!line.includes("Private prompt"));
 }
 assert.deepEqual(charged,[1,1,1]);
});
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
   assert.match(prompt,/Chế độ là ý định biên tập do người dùng chọn, không phải bằng chứng hình ảnh/);
   assert.match(prompt,/Không suy ra có người, mặt người hay người đang nói chỉ từ chế độ/);
   assert.match(prompt,/Chỉ mô tả người hoặc mặt khi nhìn thấy rõ trong ảnh mẫu/);
   assert.ok(!/Video có người|Video có mặt người|Video có người đang nói/.test(prompt),"selected mode must not assert that a person or face was visually observed");
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
  assert.match(scriptPrompt,/Chế độ là ý định biên tập do người dùng chọn, không phải bằng chứng hình ảnh/);
  assert.match(scriptPrompt,/Không suy ra có người, mặt người hay người đang nói chỉ từ chế độ/);
  assert.match(scriptPrompt,/Chỉ mô tả người hoặc mặt khi nhìn thấy rõ trong ảnh mẫu/);
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
await check("voice list, authorization and speech permission errors identify their actual operation",async()=>{
 const requests=[];
 requestFetch=async(url,init)=>{requests.push({url,method:init?.method||"GET"});return Response.json({detail:{status:"missing_permissions"}},{status:403});};
 const assertPermission=(hint,excluded)=>error=>{assert.equal(error.code,"PROVIDER_PERMISSION");assert.equal(error.status,422);assert.equal(error.action,"contact_admin");assert.match(error.message,hint);assert.doesNotMatch(error.message,excluded);return true;};
 await assert.rejects(eleven.listVoices("offline",alice),assertPermission(/Voices: Read/,/Voices: Write|Text to Speech/));
 await server.saveAuthorizedVoice(alice,"permissionShared123","Shared permission fixture","shared");
 await assert.rejects(eleven.authorizeVoice(alice,"permissionShared123"),assertPermission(/Voices: Read/,/Voices: Write|Text to Speech/));
 await assert.rejects(eleven.generateSpeech({key:"offline",userId:alice,voiceId:"permissionShared123",duration:5,segments:[{start:0,end:5,text:"Câu thử."}]}),assertPermission(/Text to Speech/,/Voices: Read|Voices: Write/));
 assert.deepEqual(requests,[
  {url:"https://api.elevenlabs.io/v1/voices",method:"GET"},
  {url:"https://api.elevenlabs.io/v1/voices/permissionShared123",method:"GET"},
  {url:"https://api.elevenlabs.io/v1/text-to-speech/permissionShared123?output_format=pcm_24000",method:"POST"},
 ]);
 assert.deepEqual(charged,[1]);
});
await check("rejected voice cloning requests Voices Write without saving a voice or exposing provider data",async()=>{
 const fakeSecret="sk-offline-clone-provider-secret",beforeVoices=[...voices.entries()],beforeMedia=[...media.entries()],beforeUnits=members.get(alice).ai_units_used;
 const sample=new File([new Uint8Array([1,2,3,4])],"sample.wav",{type:"audio/wav"});
 let requests=0;
 requestFetch=async(url,init)=>{
  requests++;
  assert.equal(url,"https://api.elevenlabs.io/v1/voices/add");assert.equal(init.method,"POST");
  assert.equal(init.headers["xi-api-key"],"offline");assert.equal(init.body.get("name"),"Giọng thử");
  const files=init.body.getAll("files");assert.equal(files.length,1);assert.equal(files[0].name,"sample.wav");assert.equal(files[0].type,"audio/wav");
  assert.deepEqual(new Uint8Array(await files[0].arrayBuffer()),new Uint8Array([1,2,3,4]));
  return Response.json({detail:{status:"missing_permissions",message:fakeSecret,required_permissions:[fakeSecret]}},{status:403});
 };
 let failure;
 await assert.rejects(eleven.cloneVoice("offline",alice,"Giọng thử",[sample]),error=>{failure=error;assert.equal(error.code,"PROVIDER_PERMISSION");assert.match(error.message,/tạo giọng cá nhân.*Voices: Write/);assert.doesNotMatch(error.message,/Voices: Read|Text to Speech/);return true;});
 const response=server.apiError(failure),body=await response.json();
 assert.equal(response.status,422);assert.equal(body.action,"contact_admin");assert.equal(body.code,"PROVIDER_PERMISSION");
 assert.ok(!JSON.stringify(body).includes(fakeSecret));assert.equal(requests,1);assert.deepEqual(charged,[10]);
 assert.equal(members.get(alice).ai_units_used,beforeUnits+10);
 assert.deepEqual([...voices.entries()],beforeVoices);assert.deepEqual([...media.entries()],beforeMedia);
});
await check("speech retries consume units and return signed WAV references",async()=>{let synths=0;requestFetch=async(url)=>{if(String(url).includes("elevenlabs")){synths++;return new Response(new Uint8Array(synths===1?144000:86400));}return Response.json({choices:[{message:{content:JSON.stringify({text:"Câu ngắn hơn."})},finish_reason:"stop"}]});};const result=await eleven.generateSpeech({key:"offline",userId:alice,voiceId:"voiceAlice123",duration:5,segments:[{start:1,end:3,text:"Đây là câu hiện quá dài."}]});assert.equal(synths,2);assert.equal(charged.length,3);assert.equal(result.segments[0].duration,1.8);assert.equal(result.segments[0].audioBase64,undefined);assert.ok(result.segments[0].audioUrl.startsWith("https://offline.supabase.invalid/"));assert.equal(media.get(result.segments[0].audioPath).length,86444);});
await check("failed timing preserves speech and blocks final export",async()=>{let synths=0;requestFetch=async(url)=>String(url).includes("elevenlabs")?(synths++,new Response(new Uint8Array(144000))):Response.json({choices:[{message:{content:JSON.stringify({text:"Vẫn quá dài"})}}]});await assert.rejects(eleven.generateSpeech({key:"offline",userId:alice,voiceId:"voiceAlice123",duration:5,segments:[{start:0,end:2,text:"Câu đầu"}]}),{code:"TIMING_NEEDS_EDIT"});assert.equal(synths,3);});
await check("admin member changes require role and validate quota",async()=>{await assert.rejects(server.listMembers(alice),{code:"ADMIN_REQUIRED"});members.get(alice).role="admin";const changed=await server.updateMember(alice,{userId:bob,enabled:true,aiUnitsLimit:50,resetUsage:true});assert.equal(changed.ai_units_limit,50);assert.equal(changed.ai_units_used,0);await assert.rejects(server.updateMember(alice,{userId:bob,aiUnitsLimit:-1}),{code:"INVALID_QUOTA"});members.get(alice).role="member";});
await check("media paths cannot access another member or traverse directories",()=>{assert.equal(supabase.assertOwnedMediaPath(alice,`${alice}/samples/voice.wav`),`${alice}/samples/voice.wav`);assert.throws(()=>supabase.assertOwnedMediaPath(alice,`${bob}/samples/voice.wav`));assert.throws(()=>supabase.assertOwnedMediaPath(alice,`${alice}/../victim.wav`));});
await check("JSON streaming enforces Vercel-safe body bound",async()=>{const request=new Request("https://app.example/api/analyze",{method:"POST",body:JSON.stringify({value:"x".repeat(500)})});await assert.rejects(server.limitedJson(request,100),{code:"PAYLOAD_TOO_LARGE"});});
await check("SQL setup limits member writes, owns storage and exposes no refund",async()=>{const sql=await fs.readFile(path.join(root,"supabase/setup.sql"),"utf8");assert.match(sql,/where user_id=auth\.uid\(\) and enabled and ai_units_used\+p_units<=ai_units_limit/);assert.match(sql,/grant update \(enabled,ai_units_limit,ai_units_used,updated_at\)/);assert.ok(!/grant update \([^)]*role/.test(sql));assert.match(sql,/authorization_tag text not null/);assert.match(sql,/alter table public\.studio_members enable row level security/);assert.match(sql,/language sql security invoker/);assert.ok(!/create[^;]*function[^;]*(refund|settle)/i.test(sql));});
console.log(`${passed} offline backend behavior tests passed.`);
