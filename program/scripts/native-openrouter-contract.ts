/** Native provider wire contract. Disposable local server, no paid requests. */
import assert from "node:assert/strict";
import { configureGateway, chat, embed, rerank } from "../../sidecars/gbrain/src/core/ai/gateway.ts";
const requests: {path:string;body:any}[]=[];
const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
  const url=new URL(request.url);const body=await request.json() as any;requests.push({path:url.pathname,body});
  assert.equal(request.headers.get("authorization"),"Bearer disposable-router-key");
  if(url.pathname.endsWith("/embeddings"))return Response.json({data:body.input.map((_:unknown,index:number)=>({index,embedding:Array(1536).fill(0.01),object:"embedding"})),usage:{prompt_tokens:1,total_tokens:1}});
  if(url.pathname.endsWith("/rerank"))return Response.json({results:[{index:0,relevance_score:0.9}]});
  return Response.json({id:"fixture",object:"chat.completion",created:0,model:body.model,choices:[{index:0,message:{role:"assistant",content:'{"facts":[]}'},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}});
}});
try{
  configureGateway({chat_model:"openrouter:openai/gpt-5-mini",embedding_model:"openrouter:openai/text-embedding-3-small",embedding_dimensions:1536,env:{OPENROUTER_API_KEY:"disposable-router-key"},base_urls:{openrouter:`http://127.0.0.1:${server.port}/api/v1`},provider_chat_options:{"openrouter:openai/gpt-5-mini":{reasoningEffort:"low"}}});
  await chat({model:"openrouter:openai/gpt-5-mini",messages:[{role:"user",content:"Fixture"}],maxTokens:4000});
  assert.equal(requests[0].body.reasoning_effort,"low");
  assert.equal((await embed(["fixture"])).at(0)?.length,1536);
  await rerank({query:"fixture",documents:["fixture"],model:"openrouter:cohere/rerank-v3.5"});
  assert.deepEqual(requests.map(r=>r.path),["/api/v1/chat/completions","/api/v1/embeddings","/api/v1/rerank"]);
  console.log(JSON.stringify({ok:true,paths:requests.map(r=>r.path),reasoningEffort:requests[0].body.reasoning_effort}));
}finally{server.stop(true);}
