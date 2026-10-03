import {defineExtension} from 'eve/extension';
import {z} from 'zod';
export default defineExtension({config:z.object({baseUrl:z.string().url(),partitionKey:z.string().min(1).max(256),tokenEnv:z.string().regex(/^[A-Z][A-Z0-9_]*$/).default('KNOWLEDGE_SERVICE_TOKEN')}).strict()});
