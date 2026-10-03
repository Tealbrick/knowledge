#!/usr/bin/env node
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {pathToFileURL} from 'node:url';
import {clientFromEnvironment,toolDefinitions,guidance} from './client.mjs';

export function createKnowledgeMcp(client) {
  const server=new Server({name:'tealbrick-knowledge',version:'0.1.0'},{capabilities:{tools:{}},instructions:guidance});
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:toolDefinitions}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    const result=await client.invoke(request.params.name,request.params.arguments??{},extra.signal);
    return {isError:result.ok!==true,content:[{type:'text',text:JSON.stringify(result)}]};
  });
  return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {await createKnowledgeMcp(clientFromEnvironment()).connect(new StdioServerTransport());}
  catch {console.error('Knowledge MCP configuration invalid. Set KNOWLEDGE_BASE_URL, KNOWLEDGE_PARTITION_KEY and KNOWLEDGE_SERVICE_TOKEN in the trusted runtime.');process.exitCode=1;}
}
