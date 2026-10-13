"""`pengupool serve` backend: build() emits the model snapshot as JSON, and topo_hash covers
structure only — a status/ctx change must NOT change it (so the extension restyles in place instead
of relaying out), while a structural change MUST."""
import io
import json

from pengupool import model, serve


def _roots(state="active", ctx=10, child_name="child"):
    child = model.Node("c1", child_name, "/repo", 2, state, status_line="[b] x ●", ctx_pct=ctx,
                       tmux_pane="%3")
    root = model.Node("r1", "root", "/repo", 1, "active", status_line="[b] y ●", ctx_pct=5,
                      children=[child])
    return [root], [("root", "c1", "spun up", "cc")], []


def test_build_shape_and_topo_hash(monkeypatch):
    monkeypatch.setattr(model, "snapshot", lambda: _roots())
    snap = serve.build()
    assert snap["roots"][0]["id"] == "r1"
    assert snap["roots"][0]["children"][0]["ctx_pct"] == 10
    assert snap["roots"][0]["children"][0]["tmux_pane"] == "%3"   # extension uses this for "attach vs start"
    assert snap["cross"] == [["root", "c1", "spun up", "cc"]]
    base = snap["topo_hash"]

    # status + ctx change only -> same topology hash (client should NOT relayout)
    monkeypatch.setattr(model, "snapshot", lambda: _roots(state="stale", ctx=99))
    assert serve.build()["topo_hash"] == base

    # a structural change (renamed node = new child identity in the shape) -> different hash
    monkeypatch.setattr(model, "snapshot", lambda: ([model.Node("r1", "root", "/repo", 1, "active")], [], []))
    assert serve.build()["topo_hash"] != base


def test_serve_once_writes_one_json_line(monkeypatch):
    monkeypatch.setattr(model, "snapshot", lambda: _roots())
    buf = io.StringIO()
    serve.serve(once=True, out=buf)
    lines = buf.getvalue().splitlines()
    assert len(lines) == 1
    obj = json.loads(lines[0])
    assert obj["rev"] == 1 and "topo_hash" in obj and obj["roots"][0]["name"] == "root"


def test_a_pane_no_session_claims_yet_shows_as_a_pending_card(monkeypatch):
    """`ctl new` makes the pane before the agent writes its session file (it waits on folder trust first),
    so the pane itself becomes a card the user can open and answer."""
    from pengupool import tmux
    monkeypatch.setattr(model, "snapshot", lambda: _roots())
    panes = {"cc": [{"pane": "%3", "pid": 30, "name": "child", "cwd": "/repo"},           # claimed by c1
                    {"pane": "%66", "pid": 66, "name": "review-agent", "cwd": "/rg"},
                    {"pane": "%70", "pid": 70, "name": "other", "cwd": "/o"}],
             "pi": [{"pane": "%3", "pid": 33, "name": "pi-one", "cwd": "/p"}]}           # same id, other server
    monkeypatch.setattr(tmux, "starting_panes", lambda h="cc": panes[h])
    monkeypatch.setattr(tmux, "pane_owns", lambda pane, pid, h: (pane, pid) == ("%70", 1))   # r1's pid runs in %70
    monkeypatch.setattr(tmux, "trust_prompt", lambda pane, h: pane == "%66")
    snap = serve.build()
    pending = {r["id"]: r for r in snap["roots"][1:]}
    assert set(pending) == {"pane-66", "pi-pane-3"}
    card = pending["pane-66"]
    assert (card["name"], card["cwd"], card["state"], card["tmux_pane"], card["harness"]) == \
        ("review-agent", "/rg", "waiting", "%66", "cc")
    assert "folder trust" in card["status"]
    assert "starting" in pending["pi-pane-3"]["status"] and pending["pi-pane-3"]["harness"] == "pi"
    assert all(r.get("pending") is True for r in pending.values())   # the extension never groups or follows these
    assert "pending" not in snap["roots"][0]                             # a real session carries no flag


def test_trust_prompt_matches_claude_codes_folder_trust_screens(monkeypatch):
    from pengupool import tmux
    for screen, want in (("Quick safety check: Is this a project you created or one you trust?\n ❯ 1. Yes, I trust this folder", True),
                         ("Do you trust the files in this folder?", True),
                         ("> how do I trust this folder in git?", False),   # a prompt typed by the user is not the screen
                         ("", False)):
        monkeypatch.setattr(tmux, "_run", lambda *a, h="cc", s=screen: s)
        assert tmux.trust_prompt("%1") is want, screen
