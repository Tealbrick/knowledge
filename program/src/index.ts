import { loadConfig } from "./config.js";
import { describeListenUrl } from "./listen-url.js";
import { buildKnowledgeApp } from "./app.js";
import {
  removeKnowledgeRuntimeFile,
  writeKnowledgeRuntimeFile,
} from "./runtime-file.js";

const config = loadConfig();
const app = await buildKnowledgeApp({ config });

await app.listen({ host: config.host, port: config.port });
await writeKnowledgeRuntimeFile({ address: app.server.address(), config });
console.log(
  JSON.stringify({
    event: "knowledge.ready",
    ...describeListenUrl(app.server.address()),
  }),
);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  await removeKnowledgeRuntimeFile({ config, pid: process.pid });
  await app.close();
  process.kill(process.pid, signal);
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
