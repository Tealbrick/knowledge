#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const specPath = path.join(here, 'public-deployment.json');
const outputs = [
  ['recipe', path.join(here, 'recipe.json')],
  ['blueprint', path.join(here, 'railway-blueprint.json')],
  ['railway', path.join(here, 'railway.json')],
];

export function validateImageReference(reference, repository) {
  if (reference === null || reference === undefined || reference === '') return null;
  const escapedRepository = repository.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`^${escapedRepository}@sha256:[a-f0-9]{64}$`);
  if (!pattern.test(reference)) {
    throw new Error(`Knowledge image must be ${repository}@sha256:<64 lowercase hex characters>`);
  }
  return reference;
}

export function validateSourceBuild(sourceBuild) {
  if (!sourceBuild || typeof sourceBuild !== 'object') throw new Error('Source-build contract is required');
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+$/.test(sourceBuild.repository)) {
    throw new Error('Source-build repository must be an HTTPS GitHub repository URL');
  }
  if (!sourceBuild.ref || sourceBuild.refType !== 'tag') {
    throw new Error('Source-build contract must use an immutable tag ref');
  }
  if (!/^[a-f0-9]{40}$/.test(sourceBuild.resolvedSourceSha)) {
    throw new Error('Source-build contract must record the resolved 40-character commit SHA');
  }
  if (sourceBuild.rootDirectory !== '/') throw new Error('Source-build root directory must be repository root');
  if (sourceBuild.dockerfilePath !== 'deploy/container/Dockerfile') {
    throw new Error('Source-build Dockerfile path must be deploy/container/Dockerfile');
  }
  return sourceBuild;
}

export function renderDeployment(spec, imageReference = spec.publicImage?.reference) {
  if (spec.schemaVersion !== 1) throw new Error('Unsupported public deployment schema version');
  const sourceBuild = validateSourceBuild(spec.sourceBuild);
  const optionalImage = validateImageReference(imageReference, spec.publicImage?.repository);
  const recipe = structuredClone(spec.recipe);
  const blueprint = structuredClone(spec.blueprint);
  const railway = structuredClone(spec.railway);

  recipe.distribution = 'public-source-and-railway-template';
  recipe.sourceBuild = structuredClone(sourceBuild);
  recipe.image = null;
  recipe.imageStatus = 'optional-public-image-not-required';
  recipe.optionalImage = optionalImage;
  recipe.imageRegistry = spec.publicImage?.repository ?? null;
  recipe.imagePullPolicy = 'optional';
  recipe.registryAuth = 'none';

  blueprint.requiredInputs.knowledgeSource = `Public source ${sourceBuild.repository} at ${sourceBuild.ref} (resolved ${sourceBuild.resolvedSourceSha})`;
  delete blueprint.requiredInputs.knowledgeImage;
  blueprint.sourceBuild = structuredClone(sourceBuild);
  blueprint.registryAuth = 'none';
  const service = blueprint.services.find(({ name }) => name === 'Knowledge');
  if (!service) throw new Error('Blueprint must contain a Knowledge service');
  service.source = {
    repository: sourceBuild.repository,
    ref: sourceBuild.ref,
    refType: sourceBuild.refType,
    rootDirectory: sourceBuild.rootDirectory,
    dockerfilePath: sourceBuild.dockerfilePath,
    resolvedSourceSha: sourceBuild.resolvedSourceSha,
  };
  service.sourcePolicy = 'Railway builds the public repository in the customer project; Portal records the resolved commit before acceptance';
  delete service.sourceAlternative;
  blueprint.templateUrl = null;
  blueprint.status = 'authored-not-created-or-published-on-railway';

  if (railway.build?.dockerfilePath !== recipe.dockerfile) {
    throw new Error('Railway service config Dockerfile path must match the Portal recipe');
  }
  if (railway.deploy?.healthcheckPath !== recipe.health.path) {
    throw new Error('Railway service health check must match the Portal recipe');
  }

  const combined = JSON.stringify({ recipe, blueprint, railway });
  if (/registryCredentials|private registry/i.test(combined) || recipe.registryAuth !== 'none' || blueprint.registryAuth !== 'none') {
    throw new Error('Public deployment artifacts must not require registry credentials');
  }
  if (service.source.resolvedSourceSha !== recipe.sourceBuild.resolvedSourceSha) {
    throw new Error('Recipe and blueprint source revisions differ');
  }
  return { recipe, blueprint, railway };
}

function main(args) {
  const checkOnly = args.includes('--check');
  const unknown = args.filter((arg) => arg !== '--check' && arg !== '--write');
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const imageReference = process.env.KNOWLEDGE_PUBLIC_IMAGE || spec.publicImage?.reference;
  const generated = renderDeployment(spec, imageReference);
  let stale = false;
  for (const [key, outputPath] of outputs) {
    const contents = `${JSON.stringify(generated[key], null, 2)}\n`;
    if (checkOnly) {
      if (fs.readFileSync(outputPath, 'utf8') !== contents) {
        console.error(`${path.basename(outputPath)} is stale; run node deploy/container/generate-public-deployment.mjs --write`);
        stale = true;
      }
    } else {
      fs.writeFileSync(outputPath, contents);
      console.log(`Wrote ${path.relative(process.cwd(), outputPath)}`);
    }
  }
  if (stale) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
