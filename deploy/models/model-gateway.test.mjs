import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createModelGateway} from './model-gateway.mjs';
const token='disposable-test-gateway-credential-not-a-real-secret';
test('slow chat does not reject embedding bursts, and each backend keeps its concurrency cap',{timeout:5000},async()=>{
 const held=[];let chats=0,maxChats=0,started=0;
 const server=createModelGateway({token,fetchImpl:async(url)=>{
  if(url.includes('chat/completions')){chats++;started++;maxChats=Math.max(maxChats,chats);await new Promise(r=>held.push(r));chats--;}
  return new Response('{}',{headers:{'content-type':'application/json'}});
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const post=(route,body)=>fetch(`http://127.0.0.1:${server.address().port}/v1/${route}`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)});
 const until=async predicate=>{while(!predicate())await new Promise(r=>setTimeout(r,5));};
 try{
  const first=post('chat/completions',{messages:[]}),second=post('chat/completions',{messages:[]});
  await until(()=>started===2);
  const third=post('chat/completions',{messages:[]});
  const embeddings=await Promise.all(Array.from({length:5},()=>post('embeddings',{input:'fixture'})));
  assert(embeddings.every(r=>r.status===200));assert.equal(started,2);
  held.shift()();await first;await until(()=>started===3);
  held.splice(0).forEach(r=>r());
  assert.equal((await second).status,200);assert.equal((await third).status,200);assert.equal(maxChats,2);
 }finally{held.splice(0).forEach(r=>r());server.closeAllConnections();server.close();}
});
test('fixed routes, bounded model choice, authentication and safe upstream handling',async()=>{
 const calls=[];
 const server=createModelGateway({token,fetchImpl:async(url,init)=>{calls.push({url,init});return new Response(JSON.stringify({ok:true}),{headers:{'content-type':'application/json'}});}});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const base=`http://127.0.0.1:${server.address().port}`;
 const post=(path,body,headers={})=>fetch(base+path,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json',...headers},body:JSON.stringify(body)});
 try{
  assert.equal((await fetch(base+'/v1/models')).status,401);
  assert.equal((await post('/v1/embeddings',{input:'test'},{authorization:'wrong'})).status,401);
  assert.equal((await post('/v1/embeddings',{input:'test'},{origin:'https://hostile.test'})).status,401);
  assert.equal((await post('/v1/embeddings?target=https://hostile.test',{input:'test'})).status,404);
  assert.equal((await post('/v1/embeddings',{model:'paid-cloud',input:'test'})).status,400);
  assert.equal((await post('/v1/embeddings',{input:'test',dimensions:1536})).status,400);
  assert.equal((await post('/v1/chat/completions',{messages:[],max_tokens:9000})).status,400);
  assert.equal((await post('/v1/chat/completions',{messages:[{content:[{type:'image_url',image_url:{url:'http://169.254.169.254/latest'}}]}]})).status,400);
  assert.equal(calls.length,0);
  assert.equal((await post('/v1/embeddings',{input:'test',dimensions:768})).status,200);
  assert.equal(calls[0].url,'http://127.0.0.1:52625/v1/embeddings');
  assert.equal(calls[0].init.headers.authorization,undefined);
  assert.equal(JSON.parse(calls[0].init.body).model,'embed-gemma:300m');
  assert.equal(calls[0].init.redirect,'error');
  const chat=await post('/v1/chat/completions',{messages:[{role:'user',content:'Synthetic test'}],max_tokens:8192});
  assert.equal(chat.status,200);
  assert.equal(chat.headers.get('x-tealbrick-output-token-cap'),'4096');
  assert.equal(JSON.parse(calls[1].init.body).max_tokens,4096);
 }finally{server.close();server.closeAllConnections();}
});
test('upstream errors never echo credentials or request content',async()=>{
 const server=createModelGateway({token,fetchImpl:async()=>new Response('private provider error',{status:500})});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 try{const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/rerank`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{}'});assert.equal(response.status,502);assert.deepEqual(await response.json(),{error:'model_unavailable'});}
 finally{server.close();server.closeAllConnections();}
});
test('cancelled queue entries do not execute or retain backend capacity',{timeout:5000},async()=>{
 let release;let started=0;
 const server=createModelGateway({token,maxConcurrent:1,fetchImpl:async()=>{
  started++;if(started===1)await new Promise(r=>{release=r;});
  return new Response('{}',{headers:{'content-type':'application/json'}});
 }});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 const post=signal=>fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:'{"messages":[]}',signal});
 try{
  const first=post();while(!release)await new Promise(r=>setTimeout(r,5));
  const controller=new AbortController();const abandoned=post(controller.signal).catch(()=>null);
  await new Promise(r=>setTimeout(r,20));controller.abort();await abandoned;
  await new Promise(r=>setTimeout(r,20));release();assert.equal((await first).status,200);
  assert.equal((await post()).status,200);assert.equal(started,2);
 }finally{release?.();server.closeAllConnections();server.close();}
});
