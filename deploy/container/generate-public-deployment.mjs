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

export function renderDeployment(spec, imageReference = spec.publicImage.reference) {
  if (spec.schemaVersion !== 1) throw new Error('Unsupported public deployment schema version');
  if (spec.publicImage.credentialsRequired !== false || spec.publicImage.pullPolicy !== 'anonymous-public-pull') {
    throw new Error('Public Knowledge image must allow anonymous pulls without registry credentials');
  }
  const image = validateImageReference(imageReference, spec.publicImage.repository);
  const recipe = structuredClone(spec.recipe);
  const blueprint = structuredClone(spec.blueprint);
  const railway = structuredClone(spec.railway);

  recipe.image = image;
  recipe.imageStatus = image ? 'digest-pinned-public-image-configured' : 'awaiting-public-image-digest';
  recipe.imageRegistry = spec.publicImage.repository;
  recipe.imagePullPolicy = spec.publicImage.pullPolicy;
  recipe.registryAuth = 'none';

  blueprint.requiredInputs.knowledgeImage = image
    ? `Configured public digest-pinned image: ${image}`
    : `Public image reference required in ${spec.publicImage.repository}@sha256:<verified digest>`;
  if (image) delete blueprint.requiredInputs.knowledgeImage;
  blueprint.registryAuth = 'none';
  const service = blueprint.services.find(({ name }) => name === 'Knowledge');
  if (!service) throw new Error('Blueprint must contain a Knowledge service');
  service.source = image
    ? { image, visibility: 'public' }
    : { image: null, requiredInput: 'knowledgeImage', visibility: 'public' };
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
  if (recipe.image !== service.source.image) throw new Error('Recipe and blueprint image references differ');
  return { recipe, blueprint, railway };
}

function main(args) {
  const checkOnly = args.includes('--check');
  const unknown = args.filter((arg) => arg !== '--check' && arg !== '--write');
  if (unknown.length) throw new Error(`Unknown arguments: ${unknown.join(' ')}`);
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  const imageReference = process.env.KNOWLEDGE_PUBLIC_IMAGE || spec.publicImage.reference;
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
