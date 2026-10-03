import extension from '../extension.js';
import {KnowledgeClient} from '../../src/client.mjs';
export function client(){const settings=extension.config;return new KnowledgeClient({baseUrl:settings.baseUrl,partitionKey:settings.partitionKey,token:()=>process.env[settings.tokenEnv]});}
