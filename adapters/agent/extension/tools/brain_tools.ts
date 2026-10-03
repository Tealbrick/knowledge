import {defineTool} from 'eve/tools';
import {catalogInput,guidance} from '../../src/client.mjs';
import {client} from '../lib/client.js';
export default defineTool({description:guidance,inputSchema:catalogInput,execute:(input,ctx)=>client().invoke('knowledge_brain_tools',input,ctx.abortSignal)});
