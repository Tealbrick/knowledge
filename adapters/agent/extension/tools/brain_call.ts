import {defineTool} from 'eve/tools';
import {callInput,guidance} from '../../src/client.mjs';
import {client} from '../lib/client.js';
export default defineTool({description:guidance,inputSchema:callInput,execute:(input,ctx)=>client().invoke('knowledge_brain_call',input,ctx.abortSignal)});
