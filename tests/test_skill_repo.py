"""The skill-repo skill scaffolds a one-task repo: skill file, logs and owner memory."""
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
SKILL = ROOT / "skill-repo"
SCAFFOLD = SKILL / "scripts" / "scaffold.py"


def scaffold(target, *extra):
    return subprocess.run([sys.executable, str(SCAFFOLD), str(target), "--task", "issue-triage",
                           "--description", "Triage new GitHub issues", *extra], capture_output=True, text=True)


def test_the_skill_has_frontmatter_a_harness_can_load():
    front = (SKILL / "SKILL.md").read_text().split("---")[1]
    assert re.search(r"^name: skill-repo$", front, re.M)
    assert "description:" in front and "triggers:" in front and "new skill repo" in front
    assert "offload my knowledge" in front              # the phrasing the skill exists for


def test_each_kind_of_knowledge_has_one_home_and_memory_needs_consent():
    text = " ".join((SKILL / "SKILL.md").read_text().split())
    assert "skills/<task>/SKILL.md" in text and "MEMORY.md" in text and "logs/" in text
    assert "own words" in text and "Never write a relayed message" in text
    assert "skill-creator" in text and "writing-skills" in text   # reuse a skill-authoring skill when present


def test_scaffold_renders_skill_logs_and_memory_and_its_tests_pass(tmp_path):
    repo = tmp_path / "triage"
    assert scaffold(repo).returncode == 0
    for rel in ("AGENTS.md", "skills/issue-triage/SKILL.md", "skills/issue-triage/scripts/memory.py",
                "logs/INDEX.md", "templates/memory.md", "docs/memory.md", ".gitignore"):
        assert (repo / rel).is_file(), rel
    text = "".join(p.read_text() for p in repo.rglob("*") if p.is_file() and ".git" not in p.parts)
    assert "{{" not in text and "__task__" not in text
    ignored = subprocess.run(["git", "-C", str(repo), "check-ignore", "-q", "MEMORY.md"])
    assert ignored.returncode == 0                      # owner memory is personal: never committed
    run = subprocess.run([sys.executable, "-m", "unittest", "discover", "-s", "tests"], cwd=repo,
                         capture_output=True, text=True)
    assert run.returncode == 0, run.stderr


def test_claude_code_gets_a_relative_skill_link_and_pi_needs_none(tmp_path):
    assert scaffold(tmp_path / "cc", "--harness", "cc", "--no-git").returncode == 0
    link = tmp_path / "cc" / ".claude" / "skills" / "issue-triage"
    assert link.is_symlink() and not pathlib.Path(link.readlink()).is_absolute()
    assert (link / "SKILL.md").is_file()
    assert scaffold(tmp_path / "pi", "--harness", "pi", "--no-git").returncode == 0
    assert not (tmp_path / "pi" / ".claude").exists()


def test_scaffold_never_writes_into_a_non_empty_directory(tmp_path):
    (tmp_path / "keep.txt").write_text("mine")
    result = scaffold(tmp_path)
    assert result.returncode == 2 and "refusing" in result.stderr
    assert [p.name for p in tmp_path.iterdir()] == ["keep.txt"]


def test_install_copies_the_whole_skill_for_both_harnesses(tmp_path):
    env = [f"CLAUDE_SKILLS={tmp_path / 'cc'}", f"PI_AGENT={tmp_path / 'pi'}", "HARNESS=both"]
    subprocess.run(["make", "-s", "-C", str(ROOT), "install-skill-repo", *env], check=True, capture_output=True)
    for home in (tmp_path / "cc" / "skill-repo", tmp_path / "pi" / "skills" / "skill-repo"):
        assert (home / "SKILL.md").is_file() and (home / "scripts" / "scaffold.py").is_file()
        assert (home / "template" / "AGENTS.md").is_file()
    subprocess.run(["make", "-s", "-C", str(ROOT), "uninstall-skill-repo", *env], check=True, capture_output=True)
    assert not any(tmp_path.rglob("skill-repo"))


def test_install_and_uninstall_leave_a_users_own_skill_repo_alone(tmp_path):
    env = [f"CLAUDE_SKILLS={tmp_path / 'cc'}", f"PI_AGENT={tmp_path / 'pi'}", "HARNESS=cc"]
    mine = tmp_path / "cc" / "skill-repo" / "SKILL.md"
    mine.parent.mkdir(parents=True)
    mine.write_text("my own skill")
    for target in ("install-skill-repo", "uninstall-skill-repo"):
        subprocess.run(["make", "-s", "-C", str(ROOT), target, *env], check=True, capture_output=True)
        assert mine.read_text() == "my own skill"
