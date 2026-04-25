---
name: "Risk Review"
description: "Review current backend changes with a bug and regression focus"
argument-hint: "Optional focus: validation, API compatibility, data integrity, etc."
agent: "ask"
model: "GPT-5 (copilot)"
---
Review the current backend workspace changes.

Focus: $ARGUMENTS

Review rules:
1. List findings first, ordered by severity.
2. Include concrete file references for each finding.
3. Prioritize behavioral bugs, regressions, API compatibility, and missing tests.
4. Keep style-only comments to a minimum.
5. If there are no findings, state that clearly and include residual risks/testing gaps.
