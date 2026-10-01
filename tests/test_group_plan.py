"""A regroup a session may propose but only the user may apply (`ctl group-plan` / `ctl group-apply`)."""
import io
import json
import sys

import pytest

from pengupool import ctl, model

A, B, C, P = (f"{c * 8}-0000" for c in "abcp")


@pytest.fixture
def pool(tmp_path, monkeypatch):
    monkeypatch.setattr(model, "GROUPS", tmp_path / "groups.json")
    monkeypatch.setattr(model, "GROUP_PLAN", tmp_path / "group-plan.json")
    live = [{"sessionId": s, "pid": 100 + i, "cwd": str(tmp_path), "name": n, "harness": h}
            for i, (s, n, h) in enumerate([(A, "lead", "cc"), (B, "kid", "cc"), (C, "docs", "cc"),
                                           (P, "pi-lead", "pi")])]
    monkeypatch.setattr(model, "load_sessions", lambda *a: live)
    monkeypatch.setattr(ctl.profiles, "caller", lambda: "")
    return tmp_path


def propose(monkeypatch, body):
    """Feed `body` to `ctl group-plan` as its stdin."""
    monkeypatch.setattr(sys, "stdin", io.StringIO(body))
    return ctl.main(["group-plan"])


def plan(*pairs, note="why not"):
    return json.dumps({"note": note, "moves": [{"child": c, "parent": p} for c, p in pairs]})


def test_groups_lists_the_parent_each_session_is_under(pool, capsys):
    model.save_groups({B: A})
    assert ctl.main(["groups"]) == 0
    out = capsys.readouterr().out
    assert "kid  parent: lead" in out
    assert "docs  parent: \u2014" in out          # ungrouped reads as a dash, not an empty field
    assert "pending proposal: none" in out
    assert ctl.main(["--json", "groups"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert {r["name"]: r["parentName"] for r in data["sessions"]} == {
        "lead": "", "kid": "lead", "docs": "", "pi-lead": ""}
    assert data["plan"] is None


def test_a_session_may_propose_and_the_plan_is_labelled_for_the_user(pool, monkeypatch, capsys):
    assert propose(monkeypatch, plan((B, A), (C, ""))) == 0
    assert "stored 2 move(s)" in capsys.readouterr().out
    stored = model.load_plan()
    assert [m["label"] for m in stored["moves"]] == ["kid under lead", "docs to top level"]
    assert stored["note"] == "why not"
    assert isinstance(stored["created"], float)
    assert model.load_groups() == {}             # proposing changes nothing at all


def test_the_proposal_is_validated_before_it_is_stored(pool, monkeypatch, capsys):
    for body, why in [
        (plan(), "the plan has no moves"),
        (plan((B, A), (B, "")), f"the plan moves {B} twice"),
        (plan((B, "nope")), "no live session nope"),
        (plan((B, P)), "harnesses never share a tree"),
        (plan((B, A), (A, B)), "own ancestor"),   # a loop only the pair creates
        (json.dumps({"moves": "kid under lead"}), "usage: pengupool ctl group-plan"),
        ("not json", "not valid JSON"),
        ("", "usage: pengupool ctl group-plan"),
    ]:
        assert propose(monkeypatch, body) == 2, why
        assert why in capsys.readouterr().err
        assert model.load_plan() == {}


def test_a_session_cannot_apply_its_own_proposal(pool, monkeypatch, capsys):
    assert propose(monkeypatch, plan((B, A))) == 0
    capsys.readouterr()
    monkeypatch.setattr(ctl.profiles, "caller", lambda: B)
    assert ctl.main(["group-apply"]) == 2
    assert "sessions cannot regroup" in capsys.readouterr().err
    assert model.load_groups() == {}
    assert model.load_plan()                      # still waiting for the user


def test_the_user_applies_the_plan_and_it_is_consumed(pool, monkeypatch, capsys):
    model.save_groups({C: A})
    assert propose(monkeypatch, plan((B, A), (C, ""))) == 0
    capsys.readouterr()
    assert ctl.main(["group-apply"]) == 0
    assert "applied 2 move(s)" in capsys.readouterr().out
    assert model.load_groups() == {B: A}          # B joined A, C was promoted to the top level
    assert model.load_plan() == {}                # consumed: never replayed


def test_a_stale_plan_is_refused_and_kept_for_the_user_to_dismiss(pool, monkeypatch, capsys):
    assert propose(monkeypatch, plan((B, A))) == 0
    capsys.readouterr()
    live = [{"sessionId": A, "pid": 1, "cwd": "/x", "name": "lead", "harness": "cc"}]   # B went away
    monkeypatch.setattr(model, "load_sessions", lambda *a: live)
    assert ctl.main(["group-apply"]) == 2
    assert "the plan is stale" in capsys.readouterr().err
    assert model.load_groups() == {}
    assert model.load_plan()


def test_discard_drops_the_plan_without_touching_the_groups(pool, monkeypatch, capsys):
    assert propose(monkeypatch, plan((B, A))) == 0
    capsys.readouterr()
    assert ctl.main(["group-apply", "--discard"]) == 0
    assert "discarded 1 proposed move(s)" in capsys.readouterr().out
    assert model.load_plan() == {} and model.load_groups() == {}
    assert ctl.main(["group-apply", "--nonsense"]) == 2
    assert "usage: pengupool ctl group-apply" in capsys.readouterr().err
    assert ctl.main(["group-apply"]) == 2        # nothing pending any more
    assert "no grouping plan is waiting" in capsys.readouterr().err
