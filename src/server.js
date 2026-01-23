import express from 'express';
import fs from 'fs';
import path from 'path';
// no YAML parsing needed anymore; use JSON backend in data/
import cors from 'cors';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const DEF_PATH = path.join(__dirname, '..', 'data', 'definition.json');

function loadDefinition() {
  try {
    const raw = fs.readFileSync(DEF_PATH, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    console.error('Failed to load definition.json:', err.message);
    return null;
  }
}


// Always return array for GET /gardens
app.get('/gardens', (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  let gardens = [];
  if (Array.isArray(def.gardens)) gardens = def.gardens;
  res.json(gardens);
});



// List all beds in a garden
app.get('/gardens/:gardenName/beds', (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });
  const garden = def.gardens.find(g => g.name === req.params.gardenName);
  console.log('Found garden:', garden);
  if (!garden || !Array.isArray(garden.beds)) return res.json([]);
  res.json(garden.beds);
});


// Get a single bed by name within a garden
app.get('/gardens/:gardenName/beds/:bedName', (req, res) => {
  const def = loadDefinition();
  if (!def || !Array.isArray(def.gardens)) return res.status(404).json({ error: 'no gardens' });
  const garden = def.gardens.find(g => g.name === req.params.gardenName);
  if (!garden || !Array.isArray(garden.beds)) return res.status(404).json({ error: 'garden or beds not found' });
  const bed = garden.beds.find(b => b.name === req.params.bedName);
  if (!bed) return res.status(404).json({ error: 'bed not found' });
  res.json(bed);
});


// Always return array for GET /plants

app.get('/plants', (req, res) => {
  const def = loadDefinition();
  if (!def || typeof def.plants !== 'object' || def.plants === null) {
    return res.json([]);
  }
  const arr = Object.entries(def.plants)
    .filter(([id, plant]) => plant && typeof plant === 'object')
    .map(([id, plant]) => ({ id, ...plant }));
  res.json(arr);
});


// Get plant details by common_name
app.get('/plants/:common_name', (req, res) => {
  const def = loadDefinition();
  if (!def || typeof def.plants !== 'object' || def.plants === null) {
    return res.status(404).json({ error: 'no plants' });
  }
  // Find by common_name (case-insensitive)
  const plant = Object.values(def.plants).find(
    p => p && typeof p === 'object' && p.common_name && p.common_name.toLowerCase() === req.params.common_name.toLowerCase()
  );
  if (!plant) return res.status(404).json({ error: 'plant not found' });
  res.json(plant);
});

// Create a new garden (persist to data/definition.json)

app.post('/gardens', (req, res) => {
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
app.put('/garden/:gardenName', (req, res) => {
  const def = loadDefinition();
  if (!def) return res.status(500).json({ error: 'definition not available' });
  def.gardens = def.gardens || [];
  const idx = def.gardens.findIndex(g => g.name === req.params.gardenName);
  if (idx === -1) return res.status(404).json({ error: 'garden not found' });
  const updated = { ...def.gardens[idx], ...(req.body || {}) };
  updated.name = req.params.gardenName; // enforce name
  def.gardens[idx] = updated;
  try {
    fs.writeFileSync(DEF_PATH, JSON.stringify(def, null, 2), 'utf8');
    res.json(updated);
  } catch (err) {
    console.error('Failed to write definition.json:', err.message);
    res.status(500).json({ error: 'failed to persist garden' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ts-moestuin server listening on http://localhost:${PORT}`));
