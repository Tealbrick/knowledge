/** Offline scorer: gold never enters the model/native execution container. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
const [receiptPath, goldPath] = process.argv.slice(2);
assert(receiptPath && goldPath);
const rows = fs.readFileSync(receiptPath,'utf8').trim().split('\n').map(JSON.parse);
const gold = new Map(JSON.parse(fs.readFileSync(goldPath,'utf8')).map(x => [x.id,x]));
const sessions = new Map(rows.filter(x => x.event === 'ingest').map(x => [`knowledge-docs/${x.documentId}`,x.session]));
const scores = {};
for (const arm of ['knowledge','native-matched','native-default']) {
  const queries = rows.filter(x => x.event === 'query' && x.arm === arm);
  const details = queries.map(row => {
    const expected = gold.get(row.id); assert(expected);
    const found = Array.isArray(row.result) ? row.result.map(hit => sessions.get(hit.slug)).filter(Boolean) : [];
    const rank = found.findIndex(id => expected.support.includes(id)) + 1;
    const support = expected.support;
    return { id:row.id, ok:row.ok, ms:row.ms, answerable:support.length>0, support, retrieved:found, anyAt5:support.some(id=>found.slice(0,5).includes(id)), allAt5:support.length>0 && support.every(id=>found.slice(0,5).includes(id)), reciprocalRank:rank>0 ? 1/rank : 0, degraded:row.retrieval?.degraded ?? null, metadataPresent:row.retrieval != null };
  });
  const answerable=details.filter(x=>x.answerable);
  scores[arm]={completed:queries.length, errors:queries.filter(x=>!x.ok).length, answerable:answerable.length, anySupportAt5:answerable.filter(x=>x.anyAt5).length, allSupportAt5:answerable.filter(x=>x.allAt5).length, meanReciprocalRank:answerable.reduce((n,x)=>n+x.reciprocalRank,0)/Math.max(1,answerable.length), metadataPresent:details.filter(x=>x.metadataPresent).length, degradedQueries:details.filter(x=>Array.isArray(x.degraded)&&x.degraded.length>0).length, details};
}
console.log(JSON.stringify({finished:rows.at(-1)?.event==='finished',metric:'support-session retrieval only; not answer accuracy',scores},null,2));
