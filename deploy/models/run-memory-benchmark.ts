// Component benchmark, NOT Knowledge API end-to-end acceptance. No live brain is mounted.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {configureGateway} from '/app/knowledge/sidecars/gbrain/src/core/ai/gateway.ts';
import {runEvalLongMemEval} from '/app/knowledge/sidecars/gbrain/src/commands/eval-longmemeval.ts';
const [dataset,arm]=process.argv.slice(2);
assert(['synthetic','pilot','full'].includes(dataset));
assert(['keyword','hybrid','reranked'].includes(arm));
for(const key of ['ANTHROPIC_API_KEY','OPENAI_API_KEY','GOOGLE_API_KEY','VOYAGE_API_KEY','OPENROUTER_API_KEY']) assert(!process.env[key],`Paid fallback forbidden: ${key}`);
assert.equal(process.env.GBRAIN_HOME,'/tmp/benchmark-home');
const model='ollama:halogen-qwen3.8-flash-next';
configureGateway({embedding_model:'llama-server:embed-gemma:300m',embedding_dimensions:768,chat_model:model,expansion_model:model,chat_fallback_chain:[],reranker_model:'llama-server-reranker:qwen3-reranker-0.6b',env:process.env,base_urls:{ollama:process.env.OLLAMA_BASE_URL!,'llama-server':process.env.LLAMA_SERVER_BASE_URL!,'llama-server-reranker':process.env.LLAMA_SERVER_RERANKER_BASE_URL!}});
const out=`/out/${dataset}-${arm}.jsonl`;
assert(!fs.existsSync(out),'Use a new named run or reconcile before resuming');
const started=Date.now();
await runEvalLongMemEval([`/input/${dataset}.json`,'--model',model,'--mode','balanced','--no-trajectory','--top-k','5','--output',out,...(arm==='keyword'?['--keyword-only']:[])],{searchConfigSnapshot:{'search.reranker.enabled':String(arm==='reranked'),'search.reranker.model':'llama-server-reranker:qwen3-reranker-0.6b','search.cache.enabled':'false'}});
fs.writeFileSync(`/out/${dataset}-${arm}.receipt.json`,JSON.stringify({at:new Date().toISOString(),ms:Date.now()-started,dataset,arm,model,embedding:'embed-gemma:300m',dimensions:768,reranker:arm==='reranked'?'qwen3-reranker-0.6b':null,topK:5,mode:'balanced',trajectory:false,expansion:false,componentOnly:true,goldLabelsExcluded:true},null,2));
