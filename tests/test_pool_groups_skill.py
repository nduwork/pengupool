"""The pool-groups skill has to stay in step with the permission model it describes."""
import pathlib
import re

ROOT = pathlib.Path(__file__).resolve().parents[1]
SKILL = ROOT / "pool-groups" / "SKILL.md"


def prose() -> str:
    """The skill's text with line wrapping normalised, so an assertion is about wording, not margins."""
    return " ".join(SKILL.read_text().split())


def test_the_skill_exists_with_frontmatter_a_harness_can_load():
    text = SKILL.read_text()
    assert text.startswith("---\n")
    front = text.split("---")[1]
    assert re.search(r"^name: pool-groups$", front, re.M)
    assert "description:" in front and "triggers:" in front
    assert "group my sessions" in front            # the phrasing a user is most likely to type


def test_it_runs_only_when_the_user_asked():
    text = prose()
    assert "Only when the user asked" in text
    assert "not an ask" in text                    # "while you're at it" does not count


def test_it_teaches_the_two_user_only_verbs_and_the_one_it_may_call():
    text = prose()
    assert "ctl group-plan" in text                # the only write a session may make
    assert "ctl group-apply" in text               # the user's step
    assert "refuses any caller that is inside a session" in text
    assert "groups.json" in text                   # named as a file not to edit by hand
    assert "never share a tree" in text            # the harness rule
    assert "who may message whom" in text          # why grouping is not cosmetic


def test_it_asks_the_user_before_submitting_and_leaves_the_apply_to_them():
    text = prose()
    assert "Show the user the whole proposal in the conversation" in text
    assert "ask whether to submit it" in text
    assert "nothing has moved yet" in text
    assert "Only after the user says yes" in text
    assert "Review Regrouping" in text             # the button that applies it


def test_the_makefile_installs_and_removes_it():
    make = (ROOT / "Makefile").read_text()
    assert "pool-groups/SKILL.md" in make
    assert "$(PI_AGENT)/skills/pool-groups" in make
