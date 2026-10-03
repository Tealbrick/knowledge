/** Disposable local provider, no real models or credentials. */
import assert from "node:assert/strict";
import { configureGateway, chat } from "../../sidecars/gbrain/src/core/ai/gateway.ts";
let received: Record<string, unknown> | undefined;
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  received = await request.json() as Record<string, unknown>;
  return Response.json({ id:"fixture",object:"chat.completion",created:0,model:"fixture-model",choices:[{index:0,message:{role:"assistant",content:'{"facts":[]}'},finish_reason:"stop"}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} });
} });
try {
  configureGateway({ chat_model:"ollama:fixture-model",embedding_model:"ollama:nomic-embed-text",env:{OLLAMA_API_KEY:"disposable"},base_urls:{ollama:`http://127.0.0.1:${server.port}/v1`},provider_chat_options:{"ollama:fixture-model":{reasoningEffort:"low"}} });
  const result=await chat({model:"ollama:fixture-model",messages:[{role:"user",content:"Synthetic extraction contract"}],maxTokens:4000});
  assert.equal(received?.reasoning_effort,"low");
  assert.equal(received?.max_tokens,4000);
  assert.equal(result.text,'{"facts":[]}');
  console.log(JSON.stringify({ok:true,nativeGateway:true,reasoningEffort:received?.reasoning_effort,providerBudget:received?.max_tokens}));
} finally { server.stop(true); }
