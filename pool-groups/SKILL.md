---
name: pool-groups
description: |
  Propose a regrouping of the PenguPool session tree and hand it to the user to approve. Use ONLY when
  the user explicitly asks for the sessions to be grouped, regrouped or reorganised — "group my
  sessions", "tidy the pool", "put these under one lead", or "/pool-groups". Never propose or apply a
  regrouping on your own initiative: the group tree decides who may message whom, so it changes only
  when the user asks for it. The proposal is stored with `pengupool ctl group-plan` and applied by the
  user in the editor; a session can never apply one.
triggers:
  - pool-groups
  - group my sessions
  - regroup the pool
  - reorganise the session tree
  - tidy the pool
  - group these sessions
  - session grouping proposal
---

# pool-groups

A regrouping is proposed by the session the user asked and approved by the user. You can read the pool
and store a proposal; you cannot apply one, and you must not try.

## When this runs

Only when the user asked, in this conversation, for the sessions to be grouped or regrouped. "While
you're at it" is not an ask, and neither is a session list you happen to be reading. If nobody asked,
answer whatever was actually asked and stop: no survey, no proposal.

## The permission model (do not work around it)

- `pengupool ctl group <child> <parent>` is how the tree moves, and it refuses any caller that is inside
  a session. You are inside one, so it will always refuse you. Do not retry it, and do not edit
  `~/.pengupool/groups.json` yourself.
- `pengupool ctl group-plan` is the one write you may make: it validates a proposal and stores it for the
  user. `pengupool ctl group-apply` is the user's step and refuses you as well.
- Grouping decides who may message whom — adjacent levels share a direct line — so propose only the moves
  the user asked for. Sessions you do not mention keep the parent they have.

## How to propose one

1. **Read the pool**: `pengupool ctl --json groups` lists every live session with its id, name, harness,
   working directory, the parent it is grouped under, and any proposal already waiting. For a session
   whose role you cannot tell from its name and directory, `pengupool ctl profile <sid>` prints its
   profile.
2. **Group what belongs together**: sessions sharing a repo, a worktree or a topic, with the one driving
   the work as the parent. Keep it small — a lead and its workers, not one tree for the whole pool.
   Harnesses never share a tree, so a pi session cannot parent a Claude Code session or the reverse. No
   loops, never a session under itself, and only ids from step 1.
3. **Show the user the whole proposal in the conversation**, in words: every move as `child under parent`
   or `child to top level`, what it is based on, and the routing effect of it. Say that nothing has moved
   yet, and ask whether to submit it.
4. **Only after the user says yes**, store it:

   ```bash
   pengupool ctl group-plan <<'JSON'
   {"note": "one line on why", "moves": [{"child": "<childSid>", "parent": "<parentSid>"},
                                         {"child": "<childSid>", "parent": ""}]}
   JSON
   ```

   `parent` of `""` promotes a session to the top level. A plan that breaks a rule prints the reason and
   stores nothing, so fix the move it names and submit again.
5. **Hand it to the user to apply**: tell them a regrouping is waiting and that the PenguPool view shows
   a notification and a **Review Regrouping** button, where the moves are listed and applied. If they
   change their mind, `pengupool ctl group-apply --discard` drops it, as does the notification's
   Discard button.

A stored proposal is inert. It waits until the user applies or discards it, and applying it consumes it.
If sessions came or went in the meantime the whole apply is refused and nothing moves: propose again from
the state you read at step 1.
