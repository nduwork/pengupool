---
name: {{task}}
description: |
  Use when asked to {{description}}. TODO: list the concrete asks that should load this skill.
triggers:
  - {{task}}
---

# {{task}}

TODO: the method. Keep it to the steps an agent cannot guess.

## Every task

1. Read `MEMORY.md` (repo root) if present and apply it.
2. Do the task. TODO: steps.
3. Write `logs/YYYY-MM-DD-<slug>.md` (asked · done · outcome · evidence) and add it to `logs/INDEX.md`.
4. Run the memory ritual (`docs/memory.md`) and reply with the outcome and the log path.
