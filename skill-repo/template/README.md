# {{repo}}

A task repo for one job: **{{description}}**

An agent session started here loads `skills/{{task}}/SKILL.md`, follows `AGENTS.md`, keeps its owner's
standing rules in a gitignored `MEMORY.md`, and logs each finished task under `logs/`.

| Path | Purpose |
| --- | --- |
| `AGENTS.md` | always-on rules for any agent here |
| `skills/{{task}}/SKILL.md` | how to do the task |
| `skills/{{task}}/scripts/memory.py` | the only writer of `MEMORY.md` (lock + compare-and-swap + verify) |
| `docs/memory.md` | memory protocol |
| `templates/memory.md` | `MEMORY.md` schema (committed) |
| `logs/` | one dated file per task, indexed in `logs/INDEX.md` |

```bash
python3 -m unittest discover -s tests -v
```
