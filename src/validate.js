import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import fs from 'fs';
import yaml from 'js-yaml';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load OpenAPI spec
const openapiPath = join(__dirname, '..', 'openapi.yaml');
const openapi = yaml.load(fs.readFileSync(openapiPath, 'utf8'));

// Load data
const dataPath = join(__dirname, '..', 'data', 'definition.json');
const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

// Convert OpenAPI schemas to JSON Schema format
function convertOpenAPIToJSONSchema(schemas) {
  const jsonSchemas = {};
  const REF_PREFIX = '#/components/schemas/';
  const ABS_PREFIX = 'https://schemas.ts-moestuin.local/';

  function rewriteRefs(value) {
    if (Array.isArray(value)) {
      return value.map(rewriteRefs);
    }

    if (value && typeof value === 'object') {
      const rewritten = {};
      Object.entries(value).forEach(([key, nested]) => {
        if (key === '$ref' && typeof nested === 'string' && nested.startsWith(REF_PREFIX)) {
          rewritten[key] = `${ABS_PREFIX}${nested.slice(REF_PREFIX.length)}`;
        } else {
          rewritten[key] = rewriteRefs(nested);
        }
      });
      return rewritten;
    }

    return value;
  }
  
  for (const [name, schema] of Object.entries(schemas)) {
    jsonSchemas[name] = {
      $id: `${ABS_PREFIX}${name}`,
      ...rewriteRefs(schema)
    };
  }
  
  return jsonSchemas;
}

const schemas = convertOpenAPIToJSONSchema(openapi.components.schemas);

// Initialize AJV
const ajv = new Ajv2020({
  schemas: Object.values(schemas),
  allErrors: true,
  unevaluated: true,
  discriminator: true,
  strict: false
});
addFormats(ajv);

function getValidator(schemaId) {
  const normalizedSchemaId = schemaId.startsWith('#/components/schemas/')
    ? `https://schemas.ts-moestuin.local/${schemaId.slice('#/components/schemas/'.length)}`
    : schemaId;

  const validate = ajv.getSchema(normalizedSchemaId);
  if (!validate) {
    throw new Error(`Validator not found for schema: ${schemaId}`);
  }
  return validate;
}

function toSchemaId(ref) {
  if (!ref || typeof ref !== 'string') {
    return null;
  }

  if (ref.startsWith('#/components/schemas/')) {
    return ref;
  }

  return null;
}

function discoverTopLevelCollectionSchemas(apiSpec, inputData) {
  const discovered = new Map();

  Object.entries(apiSpec.paths || {}).forEach(([pathKey, pathDef]) => {
    const getDef = pathDef?.get;
    if (!getDef) {
      return;
    }

    const schema = getDef.responses?.['200']?.content?.['application/json']?.schema;
    if (!schema || schema.type !== 'array') {
      return;
    }

    const schemaId = toSchemaId(schema.items?.$ref);
    if (!schemaId) {
      return;
    }

    const segments = pathKey.split('/').filter(Boolean);
    const topLevelKey = segments[0];
    if (!topLevelKey || !Object.prototype.hasOwnProperty.call(inputData, topLevelKey)) {
      return;
    }

    if (!Array.isArray(inputData[topLevelKey])) {
      return;
    }

    if (!discovered.has(topLevelKey)) {
      discovered.set(topLevelKey, schemaId);
    }
  });

  return discovered;
}

function itemLabel(value, index) {
  if (value && typeof value === 'object') {
    if (typeof value.name === 'string') return value.name;
    if (typeof value.common_name === 'string') return value.common_name;
    if (typeof value.plant_id === 'string') return value.plant_id;
  }
  return `#${index}`;
}

function validateCollection(key, schemaId, inputData) {
  const validate = getValidator(schemaId);
  const items = inputData[key];
  let hasErrors = false;

  console.log(`\nValidating ${key} against ${schemaId}...`);

  items.forEach((item, index) => {
    if (!validate(item)) {
      console.error(`\n❌ Validation failed for ${key}[${index}] (${itemLabel(item, index)}):`);
      console.error(JSON.stringify(validate.errors, null, 2));
      hasErrors = true;
    } else {
      console.log(`✓ ${key}[${index}] (${itemLabel(item, index)}) is valid`);
    }
  });

  return hasErrors;
}

const discoveredCollections = discoverTopLevelCollectionSchemas(openapi, data);
let hasErrors = false;

if (discoveredCollections.size === 0) {
  console.warn('⚠️ No top-level collections discovered from OpenAPI GET 200 array responses.');
}

for (const [key, schemaId] of discoveredCollections.entries()) {
  if (validateCollection(key, schemaId, data)) {
    hasErrors = true;
  }
}

const discoveredKeys = new Set(discoveredCollections.keys());
Object.keys(data).forEach((key) => {
  if (!discoveredKeys.has(key)) {
    console.warn(`⚠️ Skipping top-level key "${key}" (no collection schema discovered in OpenAPI).`);
  }
});

if (hasErrors) {
  console.error('\n❌ Validation completed with errors');
  process.exit(1);
} else {
  console.log('\n✅ All validation passed!');
  process.exit(0);
}
