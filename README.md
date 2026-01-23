# ts-moestuin server

Minimal Express server that serves the garden definition in `definition.yaml`.

Quick start:

```bash
npm install
npm start
```

Endpoints:
- `GET /garden` — full garden definition
- `GET /beds` — list beds
- `GET /beds/{id}` — single bed
- `GET /plants` — plants map
- `GET /plants/{id}` — single plant
