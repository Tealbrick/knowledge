import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderDeployment, validateImageReference } from './generate-public-deployment.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const spec = JSON.parse(fs.readFileSync(path.join(here, 'public-deployment.json'), 'utf8'));

test('unconfigured public image fails closed and emits consistent recipe and blueprint', () => {
  const { recipe, blueprint, railway } = renderDeployment(spec);
  const knowledge = blueprint.services.find(({ name }) => name === 'Knowledge');

  assert.equal(recipe.distribution, 'public-source-and-digest-pinned-image');
  assert.equal(recipe.image, null);
  assert.equal(recipe.imageStatus, 'awaiting-public-image-digest');
  assert.equal(recipe.registryAuth, 'none');
  assert.equal(recipe.mcp.inImage, false);
  assert.equal(recipe.mcp.protocol, 'stdio');
  assert.equal(recipe.customerRuntimeAuth.instanceTokenForAgents, false);
  assert.equal(recipe.attachmentAuth.status, 'legacy-optional');
  assert.deepEqual(knowledge.source, { image: null, requiredInput: 'knowledgeImage', visibility: 'public' });
  assert.equal(blueprint.registryAuth, 'none');
  assert.equal(blueprint.templateUrl, null);
  assert.equal(blueprint.status, 'authored-not-created-or-published-on-railway');
  assert.equal(railway.build.dockerfilePath, recipe.dockerfile);
  assert.equal(recipe.sourceContext, 'standalone-repository-root');
  assert.equal(recipe.buildContext.kind, 'standalone-repository-root-or-allowlisted-export');
  assert.equal(railway.deploy.healthcheckPath, recipe.health.path);
  assert.equal(JSON.stringify({ recipe, blueprint, railway }).includes('registryCredentials'), false);
});

test('rejects mutable tags and image references from another registry', () => {
  assert.throws(() => validateImageReference(`${spec.publicImage.repository}:latest`, spec.publicImage.repository), /sha256/);
  assert.throws(() => validateImageReference('ghcr.io/example/knowledge:latest', spec.publicImage.repository), /sha256/);
});
