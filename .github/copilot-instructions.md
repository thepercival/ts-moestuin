# Project Guidelines

## Architecture
- This repository is a Node.js Express API (`src/server.js`) driven by the OpenAPI contract in `openapi.yaml`.
- Data validation logic lives in `src/validate.js` and must stay aligned with both `openapi.yaml` and `data/definition.json`.

## Build and Test
- Install dependencies: `npm install`
- Run API locally: `npm start`
- Validate contract and data: `npm run validate`
- Do not run `npm test` here because the current script is recursive; use `npm run validate` for verification unless the test script is fixed.

## Conventions
- Prefer minimal, reviewable diffs and keep endpoint behavior backward compatible unless explicitly requested.
- When changing API payloads or validation rules, update both `openapi.yaml` and corresponding runtime validation.
- For code review requests, prioritize bug risks, regressions, and missing verification steps over style suggestions.
