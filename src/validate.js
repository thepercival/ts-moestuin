import Ajv from 'ajv';
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
  
  for (const [name, schema] of Object.entries(schemas)) {
    jsonSchemas[name] = {
      $id: `#/components/schemas/${name}`,
      ...schema
    };
  }
  
  return jsonSchemas;
}

const schemas = convertOpenAPIToJSONSchema(openapi.components.schemas);

// Initialize AJV
const ajv = new Ajv({
  schemas: Object.values(schemas),
  allErrors: true,
  strict: false
});
addFormats(ajv);

// Validate gardens
console.log('Validating gardens...');
let hasErrors = false;

for (const garden of data.gardens) {
  const validate = ajv.getSchema('#/components/schemas/Garden');
  const valid = validate(garden);
  
  if (!valid) {
    console.error(`\n❌ Validation failed for garden "${garden.name}":`);
    console.error(JSON.stringify(validate.errors, null, 2));
    hasErrors = true;
  } else {
    console.log(`✓ Garden "${garden.name}" is valid`);
  }
}

// Validate plants
console.log('\nValidating plants...');

for (const plant of data.plants) {
  const validate = ajv.getSchema('#/components/schemas/Plant');
  const valid = validate(plant);
  
  if (!valid) {
    console.error(`\n❌ Validation failed for plant "${plant.common_name}":`);
    console.error(JSON.stringify(validate.errors, null, 2));
    hasErrors = true;
  } else {
    console.log(`✓ Plant "${plant.common_name}" is valid`);
  }
}

if (hasErrors) {
  console.error('\n❌ Validation completed with errors');
  process.exit(1);
} else {
  console.log('\n✅ All validation passed!');
  process.exit(0);
}
