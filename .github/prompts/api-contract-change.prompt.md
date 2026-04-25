---
name: "API Contract Change"
description: "Plan and implement a backend API contract + validation change safely"
argument-hint: "Describe the API change to make"
agent: "agent"
model: "GPT-5 (copilot)"
---
Implement this API change: $ARGUMENTS

Requirements:
1. Identify impacted files in this repository.
2. Update `openapi.yaml` and matching runtime validation/code.
3. Keep backward compatibility unless the request explicitly allows a breaking change.
4. Provide a short risk list and verification commands to run.
5. Summarize the final diff by file.
