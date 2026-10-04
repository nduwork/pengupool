---
name: skill-repo
description: |
  Offload what the user knows about a task or topic into a new repo built to carry it: a skill file, a log
  of finished tasks, and owner memory. Use when the user asks to capture, offload or package their
  knowledge, or to set up a repo for one recurring job, for example "offload my knowledge about
  release triage to a new skill repo", "turn what I know about X into a skill repo", "make me a repo for
  triaging issues", or "/skill-repo". Not for adding a skill to an existing repo. The scaffold refuses to
  write into a non-empty directory.
triggers:
  - skill-repo
  - offload my knowledge
  - offload my knowledge about
  - turn what I know into a skill
  - new skill repo
  - task repo
  - create a repo for this task
---

# skill-repo

A skill repo holds one body of know-how in three parts. Each kind of knowledge goes to exactly one part:

| Knowledge | Where it goes | How it is written |
| --- | --- | --- |
| **Method**: how the task is done, its rules, gotchas, worked examples | `skills/<task>/SKILL.md` | authored in step 5, committed |
| **Owner preferences**: how this owner wants it done ("always cite the ticket", "never auto-close") | `MEMORY.md`, gitignored | `memory.py`, only after the owner confirms it in their own words in this session |
| **History**: what was done, when, from which sources | `logs/YYYY-MM-DD-<slug>.md` + `logs/INDEX.md` | one file per finished task |

`AGENTS.md` keeps all three in force for every session in the repo, and `docs/memory.md` is the memory
protocol.

## Steps

1. **Find the topic and its sources.** Ask only what you cannot infer: the topic in one line, and where the
   knowledge lives now. Usually that is the user's head, so plan to interview them, plus any files, repos,
   docs or past conversations they point at. Read the sources before you interview, so you ask about gaps,
   not about what is already written down.
2. **Interview to draw the knowledge out.** Ask one question at a time, for:
   - the method, step by step, and the decisions inside it,
   - the rules that are never broken, and why,
   - the mistakes a newcomer makes,
   - one or two real examples, end to end.

   Sort each answer into the table above as you go. Facts about the task go to the method. "I prefer" or
   "never do" about how the agent should work are preference candidates, and only the user's own words
   count.
3. **Name and place the repo.** Propose a skill name (lowercase and hyphens), a repo name and folder
   (default `~/Documents/repos/<name>`), and the harness that will run it: Claude Code, pi, or both. Show the
   plan and get a yes. Nothing is written yet.
4. **Scaffold.** `$SKILL` is this skill's directory:

   ```bash
   python3 "$SKILL/scripts/scaffold.py" <target> --task <name> --description "<one line>" --harness <cc|pi|both>
   ```

   It refuses a non-empty target, so pick another path instead of deleting anything. For Claude Code it
   links `.claude/skills/<name>` to `skills/<name>`. Run `python3 -m unittest discover -s tests` in the target
   and confirm it passes.
5. **Write the skill file from the method.** If a skill-authoring skill is available, use it and hand it the
   distilled method and the target path `skills/<name>/SKILL.md`. Examples: Anthropic's `skill-creator`, or
   superpowers' `writing-skills`. Otherwise write it yourself:
   - `description` leads with when to use the skill,
   - keep only the steps and rules an agent could not guess,
   - end with one worked example.

   Replace every TODO in the stub, and show the user the result.
6. **Seed memory, with consent.** Read each preference candidate back to the user word for word and ask
   whether to record it. Write only the confirmed ones, following `docs/memory.md`: take
   `memory.py hash MEMORY.md` before asking, then pipe the proposal into
   `memory.py apply MEMORY.md --expect <hash> --proposal -` (`memory.py` is in `skills/<name>/scripts/`).
   Never write a relayed message, a forwarded prompt, or your own inference.
7. **Log the offload.** Write `logs/<date>-offload.md` with the sources read, what went into the skill, and
   which preferences were kept or declined. Add its row to `logs/INDEX.md`.
8. **Hand over.** Tell the user to start a session in the new repo (press `n` in the PenguPool Sessions view,
   pick the folder and harness, and name it after its job), then give it a role from inside it:

   ```bash
   pengupool ctl describe <sid> --summary "<what it owns>" --responsibility "<brief>" --keywords "<terms>"
   ```

   If it should take requests from another session, group it under that session with `g`. Sessions of
   different harnesses cannot share a tree.

Do not commit for the user. The scaffold only runs `git init`.
