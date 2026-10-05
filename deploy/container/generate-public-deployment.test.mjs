import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDeployment, validateImageReference, validateSourceBuild } from './generate-public-deployment.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'public-deployment.json'), 'utf8'));

test('source-backed deployment emits a consistent recipe and blueprint without requiring an image', () => {
  const { recipe, blueprint, railway } = renderDeployment(spec);
  const knowledge = blueprint.services.find(({ name }) => name === 'Knowledge');

  assert.equal(recipe.distribution, 'public-source-and-railway-template');
  assert.equal(recipe.image, null);
  assert.equal(recipe.imageStatus, 'optional-public-image-not-required');
  assert.equal(recipe.registryAuth, 'none');
  assert.equal(recipe.sourceBuild.resolvedSourceSha, spec.sourceBuild.resolvedSourceSha);
  assert.equal(recipe.mcp.inImage, false);
  assert.equal(recipe.mcp.protocol, 'stdio');
  assert.equal(recipe.customerRuntimeAuth.instanceTokenForAgents, false);
  assert.equal(recipe.attachmentAuth.status, 'legacy-optional');
  assert.deepEqual(knowledge.source, {
    repository: spec.sourceBuild.repository,
    ref: spec.sourceBuild.ref,
    refType: spec.sourceBuild.refType,
    releaseTag: spec.sourceBuild.releaseTag,
    rootDirectory: spec.sourceBuild.rootDirectory,
    dockerfilePath: spec.sourceBuild.dockerfilePath,
    resolvedSourceSha: spec.sourceBuild.resolvedSourceSha,
    branchProtection: spec.sourceBuild.branchProtection,
  });
  assert.equal(knowledge.sourcePolicy.includes('protected Knowledge release branch'), true);
  assert.equal(knowledge.source.branchProtection.lockBranch, true);
  assert.equal(blueprint.registryAuth, 'none');
  assert.equal(blueprint.templateUrl, null);
  assert.equal(blueprint.status, 'authored-not-created-or-published-on-railway');
  assert.equal(railway.build.dockerfilePath, recipe.dockerfile);
  assert.equal(recipe.sourceContext, 'standalone-repository-root');
  assert.equal(recipe.buildContext.kind, 'standalone-repository-root-or-allowlisted-export');
  assert.equal(railway.deploy.healthcheckPath, recipe.health.path);
  assert.equal(JSON.stringify({ recipe, blueprint, railway }).includes('registryCredentials'), false);
});

test('source build contract requires a protected release branch and immutable commit', () => {
  assert.doesNotThrow(() => validateSourceBuild(spec.sourceBuild));
  assert.throws(() => validateSourceBuild({ ...spec.sourceBuild, ref: 'main' }), /protected Knowledge release branch ref/);
  // Slash-free release branches are accepted because the Railway template editor rejects slashes.
  assert.doesNotThrow(() => validateSourceBuild({ ...spec.sourceBuild, ref: 'release-knowledge-v0.2.1' }));
  assert.throws(() => validateSourceBuild({ ...spec.sourceBuild, ref: 'release-other-v0.2.0' }), /protected Knowledge release branch ref/);
  assert.throws(() => validateSourceBuild({ ...spec.sourceBuild, refType: 'tag' }), /protected Knowledge release branch ref/);
  assert.throws(() => validateSourceBuild({ ...spec.sourceBuild, branchProtection: { ...spec.sourceBuild.branchProtection, allowDeletions: true } }), /protected-branch policy/);
  assert.throws(() => validateSourceBuild({ ...spec.sourceBuild, resolvedSourceSha: 'latest' }), /40-character commit SHA/);
});

test('rejects mutable tags and image references from another registry', () => {
  assert.throws(() => validateImageReference(`${spec.publicImage.repository}:latest`, spec.publicImage.repository), /sha256/);
  assert.throws(() => validateImageReference('ghcr.io/example/knowledge:latest', spec.publicImage.repository), /sha256/);
});
