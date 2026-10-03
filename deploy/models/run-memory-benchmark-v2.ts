import fs from 'node:fs';
import assert from 'node:assert/strict';
import {configureGateway} from '/app/knowledge/sidecars/gbrain/src/core/ai/gateway.ts';
import {runEvalLongMemEval} from '/app/knowledge/sidecars/gbrain/src/commands/eval-longmemeval.ts';
const [dataset,arm,label,limit]=process.argv.slice(2);
assert(['synthetic','pilot','full'].includes(dataset));assert(['keyword','hybrid','reranked'].includes(arm));assert(/^[a-z0-9-]+$/.test(label));
for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','VOYAGE_API_KEY','OPENROUTER_API_KEY'])assert(!process.env[key]);
assert.equal(process.env.GBRAIN_HOME,'/tmp/benchmark-home');
const model='ollama:halogen-qwen3.8-flash-next';
configureGateway({embedding_model:'llama-server:embed-gemma:300m',embedding_dimensions:768,chat_model:model,expansion_model:model,chat_fallback_chain:[],reranker_model:'llama-server-reranker:qwen3-reranker-0.6b',env:process.env,base_urls:{ollama:process.env.OLLAMA_BASE_URL!,'llama-server':process.env.LLAMA_SERVER_BASE_URL!,'llama-server-reranker':process.env.LLAMA_SERVER_RERANKER_BASE_URL!}});
const out=`/out/${label}.jsonl`;assert(!fs.existsSync(out));
let n=0;
// Same original GBrain reader prompt and rendered sessions, with explicit local-model budget.
const client={async create(p:any){
 const start=Date.now();
 const r=await fetch(process.env.OLLAMA_BASE_URL+'/chat/completions',{method:'POST',headers:{authorization:`Bearer ${process.env.OLLAMA_API_KEY}`,'content-type':'application/json'},body:JSON.stringify({model:'halogen-qwen3.8-flash-next',temperature:0,max_tokens:4096,reasoning_effort:'low',messages:[{role:'system',content:p.system},...p.messages]}),signal:AbortSignal.timeout(120000)});
 const data=await r.json();const choice=data.choices?.[0];const text=choice?.message?.content??'';
 fs.appendFileSync(`/out/${label}-llm.jsonl`,JSON.stringify({n:++n,http:r.status,ms:Date.now()-start,finishReason:choice?.finish_reason,usage:data.usage,chars:text.length,error:data.error?.message})+'\n');
 assert(r.ok&&text.trim()&&choice?.finish_reason!=='length','Incomplete model answer; do not score as success');
 return {content:[{type:'text',text}],usage:{input_tokens:data.usage?.prompt_tokens??0,output_tokens:data.usage?.completion_tokens??0},stop_reason:'end_turn'};
}};
const started=Date.now();
await runEvalLongMemEval([`/input/${dataset}.json`,'--model',model,'--mode','balanced','--no-trajectory','--top-k','5','--output',out,...(limit?['--limit',limit]:[]),...(arm==='keyword'?['--keyword-only']:[])],{client:client as any,searchConfigSnapshot:{'search.reranker.enabled':String(arm==='reranked'),'search.reranker.model':'llama-server-reranker:qwen3-reranker-0.6b','search.cache.enabled':'false'}});
fs.writeFileSync(`/out/${label}.receipt.json`,JSON.stringify({at:new Date().toISOString(),ms:Date.now()-started,dataset,arm,model,embedding:'embed-gemma:300m',dimensions:768,reranker:arm==='reranked'?'qwen3-reranker-0.6b':null,topK:5,mode:'balanced',maxTokens:4096,reasoningEffort:'low',trajectory:false,expansion:false,componentOnly:true,goldLabelsExcluded:true},null,2));
