---
name: check-change
description: Review a local code change and run focused checks. Use when the user asks to verify a patch before committing.
---

Read the repository's AGENTS.md and inspect the current diff.
Follow each changed function to its callers and relevant tests.
Run the smallest relevant verification command already provided by the project.
Report concrete failures with file paths, then state which checks passed and what remains unverified.
Do not commit or publish anything unless the user requested it.
