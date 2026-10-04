#!/usr/bin/env python3
"""Render skill-repo/template into a new task repo, git-init it, print next steps. Stdlib only.

    scaffold.py TARGET --task NAME --description "one line" [--harness cc|pi|both] [--no-git]

`{{task}}`, `{{repo}}`, `{{description}}` and `{{date}}` are replaced in file contents; a `__task__`
path segment becomes the task name and `gitignore` becomes `.gitignore`. Refuses a non-empty TARGET.
For Claude Code (`cc`, `both`) it links `.claude/skills/<task>` to `skills/<task>`; pi reads `skills/` as is.
"""
from __future__ import annotations

import argparse
import datetime
import os
import re
import subprocess
import sys

TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "template")
NAME_OK = re.compile(r"[a-z0-9][a-z0-9-]{0,63}")


def render(target: str, values: dict[str, str]) -> list[str]:
    written = []
    for root, dirs, files in os.walk(TEMPLATE):
        dirs[:] = [d for d in dirs if d != "__pycache__" and not d.startswith(".")]  # no bytecode from a test run
        for name in (f for f in files if not f.startswith(".")):  # .DS_Store and friends are not templates
            src = os.path.join(root, name)
            rel = os.path.relpath(src, TEMPLATE).replace("__task__", values["task"])
            rel = ".gitignore" if rel == "gitignore" else rel
            with open(src, encoding="utf-8") as fh:
                text = fh.read()
            for key, val in values.items():
                text = text.replace("{{" + key + "}}", val)
            dst = os.path.join(target, rel)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(dst, "w", encoding="utf-8") as fh:
                fh.write(text)
            os.chmod(dst, os.stat(src).st_mode & 0o777)
            written.append(rel)
    return sorted(written)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="scaffold.py")
    p.add_argument("target")
    p.add_argument("--task", required=True, help="skill name: lowercase, digits, hyphens")
    p.add_argument("--description", required=True, help="one line: what this repo does")
    p.add_argument("--harness", choices=("cc", "pi", "both"), default="both")
    p.add_argument("--no-git", action="store_true")
    a = p.parse_args(argv)
    if not NAME_OK.fullmatch(a.task):
        print(f"scaffold.py: --task {a.task!r} must be lowercase letters, digits and hyphens", file=sys.stderr)
        return 2
    target = os.path.abspath(os.path.expanduser(a.target))
    if os.path.exists(target) and (not os.path.isdir(target) or os.listdir(target)):
        print(f"scaffold.py: {target} exists and is not an empty directory; refusing to overwrite", file=sys.stderr)
        return 2
    values = {"task": a.task, "repo": os.path.basename(target), "description": a.description.strip(),
              "date": datetime.date.today().isoformat()}
    files = render(target, values)
    if a.harness in ("cc", "both"):  # relative, so the link survives moving or cloning the repo
        os.makedirs(os.path.join(target, ".claude", "skills"))
        os.symlink(os.path.join("..", "..", "skills", a.task), os.path.join(target, ".claude", "skills", a.task))
        files.append(f".claude/skills/{a.task} -> skills/{a.task}")
    if not a.no_git:
        subprocess.run(["git", "init", "-q", target], check=True)
    print("\n".join(["created " + target, *("  " + f for f in files), "", "next:",
                     f"  1. fill in {target}/skills/{a.task}/SKILL.md (the TODOs)",
                     f"  2. cd {target} && python3 -m unittest discover -s tests",
                     "  3. start a PenguPool session there and give it a role:",
                     '     pengupool ctl describe <sid> --summary "..." --responsibility "..." --keywords "..."']))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
