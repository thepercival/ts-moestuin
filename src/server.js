import express from 'express';
import fs from 'fs';
import path from 'path';
import cors from 'cors';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const DEF_PATH = path.join(__dirname, '..', 'data', 'definition.json');
const OPENAPI_PATH = path.join(__dirname, '..', 'openapi.yaml');
const FOOTPRINT_GRID_SIZE_CM = 50;

const runtimeAjv = new Ajv({ allErrors: true, strict: false });
addFormats(runtimeAjv);

function loadOpenApi() {
  try {
    const raw = fs.readFileSync(OPENAPI_PATH, 'utf8');
    return yaml.load(raw);
  } catch (err) {
    console.error('Failed to load openapi.yaml:', err.message);
    return null;
  }
}

const openApiSpec = loadOpenApi();

function initializeOpenApiSchemas(spec) {
  if (!spec || !spec.components || !spec.components.schemas) {
    return;
  }

  Object.entries(spec.components.schemas).forEach(([name, schema]) => {
    runtimeAjv.addSchema({ ...schema, $id: `#/components/schemas/${name}` });
  });
}

initializeOpenApiSchemas(openApiSpec);

function getRequestBodySchema(pathName, methodName) {
  const operation = openApiSpec?.paths?.[pathName]?.[methodName?.toLowerCase()];
  return operation?.requestBody?.content?.['application/json']?.schema;
}

function getOperation(pathName, methodName) {
  return openApiSpec?.paths?.[pathName]?.[methodName?.toLowerCase()];
}

function getOperationParameters(pathName, methodName) {
  const pathParameters = openApiSpec?.paths?.[pathName]?.parameters || [];
  const operationParameters = getOperation(pathName, methodName)?.parameters || [];
  const merged = new Map();

  [...pathParameters, ...operationParameters].forEach((parameter) => {
    if (!parameter || !parameter.name || !parameter.in) {
      return;
    }
    merged.set(`${parameter.in}:${parameter.name}`, parameter);
  });

  return Array.from(merged.values());
}

function buildParameterSchema(parameters, source) {
  const scoped = parameters.filter((parameter) => parameter.in === source && parameter.schema);

  if (!scoped.length) {
    return null;
  }

  const properties = {};
  const required = [];

  scoped.forEach((parameter) => {
    properties[parameter.name] = parameter.schema;
    if (parameter.required) {
      required.push(parameter.name);
    }
  });

  return {
    type: 'object',
    properties,
    required,
    additionalProperties: true
  };
}

function createOperationValidator(pathName, methodName) {
  const parameterDefinitions = getOperationParameters(pathName, methodName);
  const pathSchema = buildParameterSchema(parameterDefinitions, 'path');
  const querySchema = buildParameterSchema(parameterDefinitions, 'query');
  const bodySchema = getRequestBodySchema(pathName, methodName);

  const validatePath = pathSchema ? runtimeAjv.compile(pathSchema) : null;
  const validateQuery = querySchema ? runtimeAjv.compile(querySchema) : null;
  const validateBody = bodySchema ? runtimeAjv.compile(bodySchema) : null;

  if (!validatePath && !validateQuery && !validateBody) {
    return (_req, _res, next) => next();
  }

  const formatErrors = (errors, prefix) => {
    return (errors || [])
      .map((error) => `${prefix}${error.instancePath || '/'} ${error.message}`)
      .join('; ');
  };

  return (req, res, next) => {
    if (validatePath && !validatePath(req.params)) {
      return res.status(400).json({ error: `path validation failed: ${formatErrors(validatePath.errors, '')}` });
    }

    if (validateQuery && !validateQuery(req.query)) {
      return res.status(400).json({ error: `query validation failed: ${formatErrors(validateQuery.errors, '')}` });
    }

    if (validateBody && !validateBody(req.body)) {
      return res.status(400).json({ error: `request body validation failed: ${formatErrors(validateBody.errors, '')}` });
    }

    return next();
  };
}

function loadDefinition() {
  try {
    const raw = fs.readFileSync(DEF_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load definition.json:', err.message);
    return null;
  }
}

function saveDefinition(definition) {
  fs.writeFileSync(DEF_PATH, JSON.stringify(definition, null, 2), 'utf8');
}

function isBedPart(part) {
  return !!part && typeof part === 'object' && typeof part.name === 'string' && (
    Array.isArray(part.growings) ||
    !!part.soil ||
    part.mulched !== undefined
  );
}

function getGardenBeds(garden) {
  if (!garden || typeof garden !== 'object') {
    return [];
  }

  if (Array.isArray(garden.beds)) {
    return garden.beds;
  }

  if (Array.isArray(garden.parts)) {
    return garden.parts.filter(isBedPart);
  }

  return [];
}

function getGardenParts(garden) {
  return Array.isArray(garden?.parts) ? garden.parts : [];
}

function getPartsByType(garden, partType) {
  return getGardenParts(garden).filter((part) => part?.part_type === partType);
}

function appendPartForGarden(definition, gardenName, partType, incomingPart) {
  definition.gardens = definition.gardens || [];
  const idx = definition.gardens.findIndex(g => g.name === gardenName);
  if (idx === -1) {
    return { error: { status: 404, message: 'garden not found' } };
  }

  if (!incomingPart || typeof incomingPart !== 'object') {
    return { error: { status: 400, message: 'part object is required' } };
  }

  if (!isGridAlignedFootprint(incomingPart)) {
    return { error: { status: 400, message: `part footprint must align to ${FOOTPRINT_GRID_SIZE_CM}cm grid` } };
  }

  const currentParts = getGardenParts(definition.gardens[idx]);
  const normalizedPart = { ...incomingPart, part_type: partType };

  definition.gardens[idx] = {
    ...definition.gardens[idx],
    name: gardenName,
    parts: [...currentParts, normalizedPart]
  };

  return { garden: definition.gardens[idx] };
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function hasPlanFootprint(footprint) {
  return !!footprint
    && typeof footprint === 'object'
    && isFiniteNumber(footprint?.position?.x_cm)
    && isFiniteNumber(footprint?.position?.y_cm)
    && isFiniteNumber(footprint?.width_cm)
    && isFiniteNumber(footprint?.height_cm)
    && footprint.width_cm > 0
    && footprint.height_cm > 0;
}

function isGridAlignedNumber(value) {
  if (!isFiniteNumber(value)) {
    return false;
  }

  const remainder = Math.abs(value % FOOTPRINT_GRID_SIZE_CM);
  const epsilon = 1e-6;
  return remainder < epsilon || Math.abs(remainder - FOOTPRINT_GRID_SIZE_CM) < epsilon;
}

function isGridAlignedFootprint(footprint) {
  return hasPlanFootprint(footprint)
    && isGridAlignedNumber(footprint.position.x_cm)
    && isGridAlignedNumber(footprint.position.y_cm)
    && isGridAlignedNumber(footprint.width_cm)
    && isGridAlignedNumber(footprint.height_cm);
}

function rectanglesOverlap(a, b) {
  return a.x < (b.x + b.width)
    && (a.x + a.width) > b.x
    && a.y < (b.y + b.height)
    && (a.y + a.height) > b.y;
}

function flattenParts(parts, result = []) {
  (parts || []).forEach((part) => {
    if (!part || typeof part !== 'object') {
      return;
    }

    result.push(part);

    if (Array.isArray(part.branches)) {
      flattenParts(part.branches, result);
    }
  });

  return result;
}

function validateGrowingsInsideBed(bedPart) {
  const growings = Array.isArray(bedPart?.growings) ? bedPart.growings : [];

  if (!growings.length) {
    return null;
  }

  for (let index = 0; index < growings.length; index += 1) {
    const growing = growings[index];
    if (!hasPlanFootprint(growing)) {
      return { status: 400, message: 'all growings in a bed must satisfy PlanFootprint' };
    }

    if (growing.position.x_cm < 0 || growing.position.y_cm < 0) {
      return { status: 400, message: 'growing must stay inside bed bounds' };
    }

    if ((growing.position.x_cm + growing.width_cm) > bedPart.width_cm || (growing.position.y_cm + growing.height_cm) > bedPart.height_cm) {
      return { status: 400, message: 'growing must stay inside bed bounds' };
    }
  }

  for (let first = 0; first < growings.length; first += 1) {
    for (let second = first + 1; second < growings.length; second += 1) {
      const a = growings[first];
      const b = growings[second];
      if (rectanglesOverlap(
        { x: a.position.x_cm, y: a.position.y_cm, width: a.width_cm, height: a.height_cm },
        { x: b.position.x_cm, y: b.position.y_cm, width: b.width_cm, height: b.height_cm }
      )) {
        return { status: 400, message: 'growings in the same bed may not overlap' };
      }
    }
  }

  return null;
}

function updatePartByNameAndType(parts, matcher, updater) {
  let updated = false;

  const nextParts = (parts || []).map((part) => {
    if (!part || typeof part !== 'object') {
      return part;
    }

    let nextPart = part;

    if (matcher(part)) {
      nextPart = updater(part);
      updated = true;
    }

    if (Array.isArray(nextPart.branches)) {
      const nested = updatePartByNameAndType(nextPart.branches, matcher, updater);
      if (nested.updated) {
        nextPart = { ...nextPart, branches: nested.parts };
        updated = true;
      }
    }

    return nextPart;
  });

  return { updated, parts: nextParts };
}

function removePartByNameAndType(parts, matcher) {
  let removed = false;

  const nextParts = (parts || []).reduce((result, part) => {
    if (!part || typeof part !== 'object') {
      result.push(part);
      return result;
    }

    if (!removed && matcher(part)) {
      removed = true;
      return result;
    }

    let nextPart = part;
    if (Array.isArray(part.branches)) {
      const nested = removePartByNameAndType(part.branches, matcher);
      if (nested.removed) {
        nextPart = { ...part, branches: nested.parts };
        removed = true;
      }
    }

    result.push(nextPart);
    return result;
  }, []);

  return { removed, parts: nextParts };
}

function validateNoPartOverlap(parts) {
  const allParts = flattenParts(parts)
    .filter((part) => hasPlanFootprint(part))
    .map((part) => ({
      name: part.name,
      part_type: part.part_type,
      rect: {
        x: part.position.x_cm,
        y: part.position.y_cm,
        width: part.width_cm,
        height: part.height_cm
      }
    }));

  for (let first = 0; first < allParts.length; first += 1) {
    for (let second = first + 1; second < allParts.length; second += 1) {
      if (rectanglesOverlap(allParts[first].rect, allParts[second].rect)) {
        return {
          status: 400,
          message: `parts may not overlap (${allParts[first].name || allParts[first].part_type} overlaps ${allParts[second].name || allParts[second].part_type})`
        };
      }
    }
  }

  return null;
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function patchGardenPartUniqueProperties(req, res, config) {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });

  const gardenIndex = def.gardens.findIndex(g => g.name === req.params.gardenName);
  if (gardenIndex === -1) return res.status(404).json({ error: 'garden not found' });

  const patchPayload = req.body?.[config.bodyKey];
  if (!isPlainObject(patchPayload)) {
    return res.status(400).json({ error: `${config.bodyKey} patch object is required` });
  }

  if (Object.prototype.hasOwnProperty.call(patchPayload, 'name')) {
    return res.status(400).json({ error: 'name is immutable and may not be changed via patch requests' });
  }

  const garden = def.gardens[gardenIndex];
  const updateResult = updatePartByNameAndType(
    getGardenParts(garden),
    (part) => part?.name === req.params[config.paramName] && part?.part_type === config.partType,
    (part) => ({ ...part, ...patchPayload })
  );

  if (!updateResult.updated) {
    return res.status(404).json({ error: 'part not found' });
  }

  const invalidBed = flattenParts(updateResult.parts)
    .find((part) => (part?.part_type === 'bed' || part?.part_type === 'embankment') && validateGrowingsInsideBed(part));

  if (invalidBed) {
    const issue = validateGrowingsInsideBed(invalidBed);
    return res.status(issue.status).json({ error: issue.message });
  }

  // Do not reject footprint updates on pre-existing overlaps in legacy definitions.
  // We still validate bed/embankment growings to keep internal bed layout consistent.

  def.gardens[gardenIndex] = {
    ...garden,
    parts: updateResult.parts
  };

  try {
    saveDefinition(def);
    return res.json(def.gardens[gardenIndex]);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    return res.status(500).json({ error: 'failed to persist part patch' });
  }
}


// Always return array for GET /gardens
app.get('/gardens', createOperationValidator('/gardens', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  let gardens = [];
  if (Array.isArray(def.gardens)) gardens = def.gardens;
  res.json(gardens);
});

// Get a single garden by name
app.get('/gardens/:gardenName', createOperationValidator('/gardens/{gardenName}', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });
  const garden = def.gardens.find(g => g.name === req.params.gardenName);
  if (!garden) return res.status(404).json({ error: 'garden not found' });
  res.json(garden);
});

// List nested gardens within a garden
app.get('/gardens/:gardenName/gardens', createOperationValidator('/gardens/{gardenName}/gardens', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });
  const garden = def.gardens.find(g => g.name === req.params.gardenName);
  if (!garden) return res.status(404).json({ error: 'garden not found' });
  res.json(Array.isArray(garden.gardens) ? garden.gardens : []);
});

// List all parts in a garden (parts-list only)
app.get('/gardens/:gardenName/parts', createOperationValidator('/gardens/{gardenName}/parts', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });
  const garden = def.gardens.find(g => g.name === req.params.gardenName);
  if (!garden) return res.status(404).json({ error: 'garden not found' });
  res.json(getGardenParts(garden));
});

app.delete('/gardens/:gardenName/parts/:partName', createOperationValidator('/gardens/{gardenName}/parts/{partName}', 'delete'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });

  const gardenIndex = def.gardens.findIndex(g => g.name === req.params.gardenName);
  if (gardenIndex === -1) return res.status(404).json({ error: 'garden not found' });

  const requestedPartType = typeof req.query.part_type === 'string' ? req.query.part_type : undefined;
  const matcher = (part) => {
    if (part?.name !== req.params.partName) {
      return false;
    }

    if (!requestedPartType) {
      return true;
    }

    return part?.part_type === requestedPartType;
  };

  const garden = def.gardens[gardenIndex];
  const removeResult = removePartByNameAndType(getGardenParts(garden), matcher);

  if (!removeResult.removed) {
    return res.status(404).json({ error: 'part not found' });
  }

  def.gardens[gardenIndex] = {
    ...garden,
    parts: removeResult.parts
  };

  try {
    saveDefinition(def);
    return res.json(def.gardens[gardenIndex]);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    return res.status(500).json({ error: 'failed to persist part delete' });
  }
});
// Always return array for GET /plants

app.get('/plants', createOperationValidator('/plants', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !def.plants) return res.json([]);
  if (Array.isArray(def.plants)) return res.json(def.plants);
  if (typeof def.plants === 'object') {
    const arr = Object.entries(def.plants)
      .filter(([id, plant]) => plant && typeof plant === 'object')
      .map(([id, plant]) => ({ id, ...plant }));
    return res.json(arr);
  }
  return res.json([]);
});


// Get plant details by common_name
app.get('/plants/:common_name', createOperationValidator('/plants/{common_name}', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !def.plants) return res.status(404).json({ error: 'no plants' });
  const plantsArray = Array.isArray(def.plants) ? def.plants : Object.values(def.plants);
  const plant = plantsArray.find(
    p => p && typeof p === 'object' && p.common_name && p.common_name.toLowerCase() === req.params.common_name.toLowerCase()
  );
  if (!plant) return res.status(404).json({ error: 'plant not found' });
  res.json(plant);
});

app.get('/seeds', createOperationValidator('/seeds', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !def.seeds) return res.json([]);
  if (Array.isArray(def.seeds)) return res.json(def.seeds);
  if (typeof def.seeds === 'object') {
    return res.json(
      Object.values(def.seeds).filter((seed) => !!seed && typeof seed === 'object')
    );
  }
  return res.json([]);
});

app.post('/seeds', createOperationValidator('/seeds', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });

  const incoming = req.body || {};
  const plantId = typeof incoming.plant_id === 'string' ? incoming.plant_id.trim() : '';
  const validUntilYear = Number(incoming.valid_until_year);
  const variantName = typeof incoming.variant_name === 'string' ? incoming.variant_name.trim() : '';
  const webshopName = typeof incoming.webshop_name === 'string' ? incoming.webshop_name.trim() : '';

  if (!plantId) {
    return res.status(400).json({ error: 'plant_id is required' });
  }

  if (!Number.isFinite(validUntilYear)) {
    return res.status(400).json({ error: 'valid_until_year is required' });
  }

  const seed = {
    ...incoming,
    plant_id: plantId,
    valid_until_year: Math.trunc(validUntilYear),
    variant_name: variantName,
    webshop_name: webshopName || undefined
  };

  if (!Array.isArray(def.seeds)) {
    def.seeds = [];
  }

  const hasDuplicate = def.seeds.some((existingSeed) => {
    if (!existingSeed || typeof existingSeed !== 'object') {
      return false;
    }

    const existingPlantId = typeof existingSeed.plant_id === 'string' ? existingSeed.plant_id.trim() : '';
    const existingValidUntilYear = Number(existingSeed.valid_until_year);
    const existingVariantName = typeof existingSeed.variant_name === 'string' ? existingSeed.variant_name.trim() : '';
    const existingWebshopName = typeof existingSeed.webshop_name === 'string' ? existingSeed.webshop_name.trim() : '';

    return existingPlantId === seed.plant_id
      && Math.trunc(existingValidUntilYear) === seed.valid_until_year
      && existingVariantName === seed.variant_name
      && existingWebshopName === (seed.webshop_name ?? '');
  });

  if (hasDuplicate) {
    return res.status(409).json({
      error: 'seed with this plant_id, variant_name, webshop_name and valid_until_year already exists'
    });
  }

  def.seeds.push(seed);

  try {
    saveDefinition(def);
    return res.status(201).json(seed);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    return res.status(500).json({ error: 'failed to persist seed' });
  }
});

app.delete('/seeds/:seedIndex', createOperationValidator('/seeds/{seedIndex}', 'delete'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });

  if (!Array.isArray(def.seeds)) {
    return res.status(404).json({ error: 'no seeds' });
  }

  const index = Number(req.params.seedIndex);
  if (!Number.isInteger(index) || index < 0 || index >= def.seeds.length) {
    return res.status(404).json({ error: 'seed not found' });
  }

  const [removed] = def.seeds.splice(index, 1);

  try {
    saveDefinition(def);
    return res.json(removed || {});
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    return res.status(500).json({ error: 'failed to persist seed delete' });
  }
});

app.get('/webshops', createOperationValidator('/webshops', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !def.webshops) return res.json([]);
  if (Array.isArray(def.webshops)) return res.json(def.webshops);
  if (typeof def.webshops === 'object') {
    return res.json(
      Object.values(def.webshops).filter((shop) => !!shop && typeof shop === 'object')
    );
  }
  return res.json([]);
});

// Create a new garden (persist to data/definition.json)

app.post('/gardens', createOperationValidator('/gardens', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  def.gardens = def.gardens || [];
  const incoming = req.body || {};
  // Use name as unique key
  if (!incoming.name) return res.status(400).json({ error: 'name is required' });
  if (def.gardens.find(g => g.name === incoming.name)) {
    return res.status(409).json({ error: 'garden with this name already exists' });
  }
  const newGarden = { ...incoming };
  def.gardens.push(newGarden);
  try {
    fs.writeFileSync(DEF_PATH, JSON.stringify(def, null, 2), 'utf8');
    res.status(201).json(newGarden);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist garden' });
  }
});


// Update an existing garden by name
app.put('/gardens/:gardenName', createOperationValidator('/gardens/{gardenName}', 'put'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  def.gardens = def.gardens || [];
  const idx = def.gardens.findIndex(g => g.name === req.params.gardenName);
  if (idx === -1) return res.status(404).json({ error: 'garden not found' });
  const updated = { ...def.gardens[idx], ...(req.body || {}) };
  updated.name = req.params.gardenName; // enforce name
  def.gardens[idx] = updated;
  try {
    saveDefinition(def);
    res.json(updated);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist garden' });
  }
});

app.post('/gardens/:gardenName/beds', createOperationValidator('/gardens/{gardenName}/beds', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  const result = appendPartForGarden(def, req.params.gardenName, 'bed', req.body?.bed);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });
  try {
    saveDefinition(def);
    res.status(201).json(result.garden);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist bed part' });
  }
});

app.patch('/gardens/:gardenName/beds/:bedName', createOperationValidator('/gardens/{gardenName}/beds/{bedName}', 'patch'), (req, res) => {
  return patchGardenPartUniqueProperties(req, res, {
    partType: 'bed',
    bodyKey: 'bed',
    paramName: 'bedName'
  });
});

app.get('/gardens/:gardenName/beds/:bedName', createOperationValidator('/gardens/{gardenName}/beds/{bedName}', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) {
    return res.status(404).json({ error: 'no gardens' });
  }

  const garden = def.gardens.find((g) => g.name === req.params.gardenName);
  if (!garden) {
    return res.status(404).json({ error: 'garden not found' });
  }

  const bed = flattenParts(getGardenParts(garden)).find((part) => {
    return part?.part_type === 'bed' && part?.name === req.params.bedName;
  });

  if (!bed) {
    return res.status(404).json({ error: 'bed not found' });
  }

  return res.json(bed);
});

app.post('/gardens/:gardenName/beds/:bedName/growings/:growingIndex/activities', createOperationValidator('/gardens/{gardenName}/beds/{bedName}/growings/{growingIndex}/activities', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) {
    return res.status(404).json({ error: 'no gardens' });
  }

  const gardenIndex = def.gardens.findIndex((g) => g.name === req.params.gardenName);
  if (gardenIndex === -1) {
    return res.status(404).json({ error: 'garden not found' });
  }

  const growingIndex = Number.parseInt(req.params.growingIndex, 10);
  if (!Number.isInteger(growingIndex) || growingIndex < 0) {
    return res.status(400).json({ error: 'invalid growing index' });
  }

  const garden = def.gardens[gardenIndex];
  const newActivity = req.body?.growing_activity;

  const updateResult = updatePartByNameAndType(
    getGardenParts(garden),
    (part) => part?.name === req.params.bedName && part?.part_type === 'bed',
    (part) => {
      const growings = Array.isArray(part?.growings) ? [...part.growings] : [];
      const targetGrowing = growings[growingIndex];

      if (!targetGrowing) {
        return part;
      }

      const activities = Array.isArray(targetGrowing.activities) ? [...targetGrowing.activities] : [];
      activities.push(newActivity);

      growings[growingIndex] = {
        ...targetGrowing,
        activities
      };

      return {
        ...part,
        growings
      };
    }
  );

  if (!updateResult.updated) {
    return res.status(404).json({ error: 'bed not found' });
  }

  const updatedBed = flattenParts(updateResult.parts).find((part) => part?.part_type === 'bed' && part?.name === req.params.bedName);
  const updatedGrowings = Array.isArray(updatedBed?.growings) ? updatedBed.growings : [];
  if (!updatedGrowings[growingIndex]) {
    return res.status(404).json({ error: 'growing not found' });
  }

  const invalidBed = flattenParts(updateResult.parts)
    .find((part) => (part?.part_type === 'bed' || part?.part_type === 'embankment') && validateGrowingsInsideBed(part));

  if (invalidBed) {
    const issue = validateGrowingsInsideBed(invalidBed);
    return res.status(issue.status).json({ error: issue.message });
  }

  def.gardens[gardenIndex] = {
    ...garden,
    parts: updateResult.parts
  };

  try {
    saveDefinition(def);
    return res.json(def.gardens[gardenIndex]);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    return res.status(500).json({ error: 'failed to persist growing activity' });
  }
});

app.post('/gardens/:gardenName/paths', createOperationValidator('/gardens/{gardenName}/paths', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  const result = appendPartForGarden(def, req.params.gardenName, 'path', req.body?.path);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });
  try {
    saveDefinition(def);
    res.status(201).json(result.garden);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist path part' });
  }
});

app.patch('/gardens/:gardenName/paths/:pathName', createOperationValidator('/gardens/{gardenName}/paths/{pathName}', 'patch'), (req, res) => {
  return patchGardenPartUniqueProperties(req, res, {
    partType: 'path',
    bodyKey: 'path',
    paramName: 'pathName'
  });
});

app.get('/gardens/:gardenName/paths/:pathName', createOperationValidator('/gardens/{gardenName}/paths/{pathName}', 'get'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) {
    return res.status(404).json({ error: 'no gardens' });
  }

  const garden = def.gardens.find((g) => g.name === req.params.gardenName);
  if (!garden) {
    return res.status(404).json({ error: 'garden not found' });
  }

  const pathPart = flattenParts(getGardenParts(garden)).find((part) => {
    return part?.part_type === 'path' && part?.name === req.params.pathName;
  });

  if (!pathPart) {
    return res.status(404).json({ error: 'path not found' });
  }

  return res.json(pathPart);
});

app.post('/gardens/:gardenName/embankments', createOperationValidator('/gardens/{gardenName}/embankments', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  const result = appendPartForGarden(def, req.params.gardenName, 'embankment', req.body?.embankment);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });
  try {
    saveDefinition(def);
    res.status(201).json(result.garden);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist embankment part' });
  }
});

app.patch('/gardens/:gardenName/embankments/:embankmentName', createOperationValidator('/gardens/{gardenName}/embankments/{embankmentName}', 'patch'), (req, res) => {
  return patchGardenPartUniqueProperties(req, res, {
    partType: 'embankment',
    bodyKey: 'embankment',
    paramName: 'embankmentName'
  });
});

app.post('/gardens/:gardenName/water-tanks', createOperationValidator('/gardens/{gardenName}/water-tanks', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  const result = appendPartForGarden(def, req.params.gardenName, 'water_tank', req.body?.water_tank);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });
  try {
    saveDefinition(def);
    res.status(201).json(result.garden);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist water_tank part' });
  }
});

app.patch('/gardens/:gardenName/water-tanks/:waterTankName', createOperationValidator('/gardens/{gardenName}/water-tanks/{waterTankName}', 'patch'), (req, res) => {
  return patchGardenPartUniqueProperties(req, res, {
    partType: 'water_tank',
    bodyKey: 'water_tank',
    paramName: 'waterTankName'
  });
});

app.post('/gardens/:gardenName/sheds', createOperationValidator('/gardens/{gardenName}/sheds', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  const result = appendPartForGarden(def, req.params.gardenName, 'shed', req.body?.shed);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });
  try {
    saveDefinition(def);
    res.status(201).json(result.garden);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist shed part' });
  }
});

app.patch('/gardens/:gardenName/sheds/:shedName', createOperationValidator('/gardens/{gardenName}/sheds/{shedName}', 'patch'), (req, res) => {
  return patchGardenPartUniqueProperties(req, res, {
    partType: 'shed',
    bodyKey: 'shed',
    paramName: 'shedName'
  });
});

app.post('/gardens/:gardenName/greenhouses', createOperationValidator('/gardens/{gardenName}/greenhouses', 'post'), (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  const result = appendPartForGarden(def, req.params.gardenName, 'greenhouse', req.body?.greenhouse);
  if (result.error) return res.status(result.error.status).json({ error: result.error.message });
  try {
    saveDefinition(def);
    res.status(201).json(result.garden);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist greenhouse part' });
  }
});

app.patch('/gardens/:gardenName/greenhouses/:greenhouseName', createOperationValidator('/gardens/{gardenName}/greenhouses/{greenhouseName}', 'patch'), (req, res) => {
  return patchGardenPartUniqueProperties(req, res, {
    partType: 'greenhouse',
    bodyKey: 'greenhouse',
    paramName: 'greenhouseName'
  });
});

app.put('/gardens/:gardenName/parts/:partName/footprint', createOperationValidator('/gardens/{gardenName}/parts/{partName}/footprint', 'put'), (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });

  const gardenIndex = def.gardens.findIndex(g => g.name === req.params.gardenName);
  if (gardenIndex === -1) return res.status(404).json({ error: 'garden not found' });

  const partType = req.body?.part_type;
  const footprint = req.body?.footprint;

  if (!partType || typeof partType !== 'string') {
    return res.status(400).json({ error: 'part_type is required' });
  }

  if (!hasPlanFootprint(footprint)) {
    return res.status(400).json({ error: 'footprint must satisfy PlanFootprint' });
  }

  if (!isGridAlignedFootprint(footprint)) {
    return res.status(400).json({ error: `footprint must align to ${FOOTPRINT_GRID_SIZE_CM}cm grid` });
  }

  const garden = def.gardens[gardenIndex];
  const updateResult = updatePartByNameAndType(
    getGardenParts(garden),
    (part) => part?.name === req.params.partName && part?.part_type === partType,
    (part) => ({
      ...part,
      position: {
        x_cm: footprint.position.x_cm,
        y_cm: footprint.position.y_cm
      },
      width_cm: footprint.width_cm,
      height_cm: footprint.height_cm,
      rotation_deg: isFiniteNumber(footprint.rotation_deg) ? footprint.rotation_deg : part.rotation_deg
    })
  );

  if (!updateResult.updated) {
    return res.status(404).json({ error: 'part not found' });
  }

  const invalidBed = flattenParts(updateResult.parts)
    .find((part) => (part?.part_type === 'bed' || part?.part_type === 'embankment') && validateGrowingsInsideBed(part));

  if (invalidBed) {
    const issue = validateGrowingsInsideBed(invalidBed);
    return res.status(issue.status).json({ error: issue.message });
  }

  // Allow footprint updates even when legacy definitions already contain overlapping parts.
  // Keep growings-in-bed validation above as the safety check for bed internals.

  def.gardens[gardenIndex] = {
    ...garden,
    parts: updateResult.parts
  };

  try {
    saveDefinition(def);
    return res.json(def.gardens[gardenIndex]);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    return res.status(500).json({ error: 'failed to persist part footprint' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ts-moestuin server listening on http://localhost:${PORT}`));
