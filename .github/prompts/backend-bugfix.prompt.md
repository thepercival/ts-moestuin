---
name: "Backend Bugfix"
description: "Fix a backend bug with minimal diff and contract-safe validation"
argument-hint: "Describe the bug and expected behavior"
agent: "agent"
model: "GPT-5 (copilot)"
---
Fix this backend issue: $ARGUMENTS

Requirements:
1. Locate root cause before editing.
2. Keep behavior backward compatible unless explicitly requested otherwise.
3. If request/response shape changes, update both `openapi.yaml` and runtime validation.
4. Keep diff minimal and explain risks.
5. Run and report validation command(s): `npm run validate`.
