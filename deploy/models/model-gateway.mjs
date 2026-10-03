import http from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {once} from 'node:events';

// Customer-owned, fixed-destination gateway. Never runs in the Teal Brick Portal.
const models={chat:'halogen-qwen3.8-flash-next',embedding:'embed-gemma:300m',rerank:'qwen3-reranker-0.6b'};
const routes={
 '/v1/chat/completions':{port:8731,kind:'chat'},
 '/v1/embeddings':{port:52625,kind:'embedding'},
 '/v1/rerank':{port:8744,kind:'rerank'},
 '/v1/extract':{port:8744,kind:'entities'},
};
export function createModelGateway({token,fetchImpl=fetch,audit=()=>{},maxConcurrent=2,timeoutMs=600000}){
 if(typeof token!=='string'||token.length<40||/[\r\n]/.test(token))throw Error('invalid_gateway_credential');
 const expected=Buffer.from(`Bearer ${token}`);
 // Independent backends must not reject embeddings while chat is generating.
 // Preserve the per-model concurrency cap; burst work waits in bounded queues.
 const lanes=new Map();let waiting=0;
 async function acquire(port,signal){
  let lane=lanes.get(port);if(!lane){lane={active:0,queue:[]};lanes.set(port,lane);}
  if(signal.aborted)throw Error('cancelled');
  if(lane.active>=maxConcurrent){
   if(waiting>=32)throw Error('capacity_busy');
   await new Promise((resolve,reject)=>{
    const entry={resolve:()=>{signal.removeEventListener('abort',abort);resolve();}};
    const abort=()=>{const i=lane.queue.indexOf(entry);if(i>=0){lane.queue.splice(i,1);waiting--;reject(Error('cancelled'));}};
    lane.queue.push(entry);waiting++;signal.addEventListener('abort',abort,{once:true});
   });
  }else lane.active++;
  return ()=>{const next=lane.queue.shift();if(next){waiting--;next.resolve();}else lane.active--;};
 }
 const server=http.createServer(async(req,res)=>{
  const started=Date.now();let release,outputBudgetCapped=false;
  const reply=(status,error)=>{if(!res.headersSent){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(error));}else res.destroy();};
  try{
   if(req.url==='/health'&&req.method==='GET'){reply(200,{status:'ok'});return;}
   const supplied=Buffer.from(req.headers.authorization??'');
   if(req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)){reply(401,{error:'unauthorized'});return;}
   if(req.url==='/v1/models'&&req.method==='GET'){reply(200,{object:'list',data:Object.values(models).map(id=>({id,object:'model',owned_by:'customer'}))});return;}
   const route=routes[req.url];
   if(!route||req.method!=='POST'){reply(404,{error:'route_not_available'});return;}
   if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??'')){reply(415,{error:'json_required'});return;}
   const buffers=[];let bytes=0;
   for await(const chunk of req){bytes+=chunk.length;if(bytes>1048576){reply(413,{error:'request_too_large'});return;}buffers.push(chunk);}
   let body;try{body=JSON.parse(Buffer.concat(buffers).toString('utf8'));}catch{reply(400,{error:'invalid_json'});return;}
   if(!body||Array.isArray(body)||typeof body!=='object'){reply(400,{error:'invalid_request'});return;}
   if(route.kind!=='entities'&&body.model!==undefined&&body.model!==models[route.kind]){reply(400,{error:'model_not_available'});return;}
   if(route.kind!=='entities')body.model=models[route.kind];
   if(route.kind==='chat'){
    if(!Array.isArray(body.messages)||body.messages.length>64){reply(400,{error:'invalid_messages'});return;}
    // No server-side fetching of caller-provided image/audio URLs.
    for(const m of body.messages)if(Array.isArray(m.content))for(const part of m.content){
     if(part.type!=='text'&&!(part.type==='image_url'&&/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(part.image_url?.url??''))){reply(400,{error:'unsupported_media'});return;}
    }
    const budget=body.max_tokens??body.max_completion_tokens??2048;
    if(!Number.isInteger(budget)||budget<1||budget>8192){reply(400,{error:'invalid_output_budget'});return;}
    // Halogen's shared-host cap is a deployment policy, not a model limit.
    // Adapt Open Notebook's fixed 8192 request without raising that host cap.
    outputBudgetCapped=budget>4096;
    body.max_tokens=Math.min(budget,4096);delete body.max_completion_tokens;
   }
   if(route.kind==='embedding'){
    const inputs=typeof body.input==='string'?[body.input]:body.input;
    if(!Array.isArray(inputs)||inputs.length<1||inputs.length>16||inputs.some(v=>typeof v!=='string'||v.length>16000)||(body.dimensions!==undefined&&body.dimensions!==768)){reply(400,{error:'invalid_embedding_input'});return;}
   }
   const abort=new AbortController();res.on('close',()=>{if(!res.writableEnded)abort.abort();});
   const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(timeoutMs)]);
   release=await acquire(route.port,signal);
   if(signal.aborted)throw Error('cancelled');
   const response=await fetchImpl(`http://127.0.0.1:${route.port}${req.url}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error',signal});
   if(!response.ok){reply(response.status===429?429:502,{error:'model_unavailable'});return;}
   res.writeHead(200,{'content-type':response.headers.get('content-type')??'application/json','cache-control':'no-store',...(outputBudgetCapped?{'x-tealbrick-output-token-cap':'4096'}:{})});
   let total=0;
   for await(const chunk of response.body){total+=chunk.length;if(total>8388608){abort.abort();throw Error('response_too_large');}if(!res.write(chunk))await once(res,'drain',{signal:abort.signal});}
   res.end();
  }catch(error){reply(error.message==='capacity_busy'?429:502,{error:error.message==='capacity_busy'?'capacity_busy':'model_unavailable'});}
  finally{release?.();try{audit({route:routes[req.url]?req.url:'other',status:res.statusCode,elapsedMs:Date.now()-started,outputBudgetCapped});}catch{}}
 });
 server.requestTimeout=15000;server.headersTimeout=10000;server.maxHeadersCount=32;
 return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const token=readFileSync(`${process.env.CREDENTIALS_DIRECTORY}/model-token`,'utf8').trim();
 createModelGateway({token,audit:event=>console.log(JSON.stringify(event))}).listen(18750,'127.0.0.1');
}
