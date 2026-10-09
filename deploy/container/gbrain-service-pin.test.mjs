// One GBrain service pin across the operation snapshot, the draft Railway template and the design doc.
// The embedded sidecar (sidecars/gbrain, frozen at 0.48.2) is a different topology and is not checked here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';

const root = new URL('../../', import.meta.url);
const read = path => readFileSync(new URL(path, root), 'utf8');

test('the GBrain service pin is one upstream tag, commit and release branch everywhere', () => {
  const snapshots = readdirSync(new URL('program/src/engine-surfaces/', root)).filter(name => /^gbrain-\d+(\.\d+)+\.json$/u.test(name));
  assert.equal(snapshots.length, 1, `exactly one GBrain service snapshot, found ${snapshots.join(', ')}`);
  const surface = JSON.parse(read(`program/src/engine-surfaces/${snapshots[0]}`));
  const { tag, commit, mirror } = surface.provenance;
  assert.match(commit, /^[0-9a-f]{40}$/u, 'pin by full commit SHA, never by a moving tag');
  assert.equal(snapshots[0], `gbrain-${tag.replace(/^v/u, '')}.json`);
  assert.equal(surface.operationCount, surface.operations.length);
  const branch = `release-gbrain-${tag}`;
  const head = /@ ([0-9a-f]{40}) /u.exec(mirror)?.[1];
  assert.ok(head, 'snapshot records the release branch head');
  assert.ok(mirror.startsWith(`Tealbrick/gbrain ${branch} @ `));

  const template = JSON.parse(read('deploy/container/railway-template.gbrain-service.draft.json'));
  const gbrain = Object.values(template.services).find(service => service.source?.repo === 'Tealbrick/gbrain');
  assert.equal(gbrain.source.branch, branch);
  assert.ok(template.$comment.includes(commit) && template.$comment.includes(head) && template.$comment.includes(tag));

  const doc = read('docs/gbrain-upstream-service.md');
  for (const value of [tag, commit, branch, head]) assert.ok(doc.includes(value), `docs/gbrain-upstream-service.md names ${value}`);
});
