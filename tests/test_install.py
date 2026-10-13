"""`pengupool setup/teardown`: nothing system-wide is installed without a yes, and each harness gets
its own wiring (Claude hooks / pi-intercom + the PenguPool pi extension)."""
import subprocess

import pytest

from pengupool import install


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_SETTINGS", str(tmp_path / "settings.json"))
    ran = []
    have = {"tmux", "claude", "omp", "bun", "brew", "pengupool"}
    monkeypatch.setattr(install.shutil, "which", lambda b: f"/bin/{b}" if b in have else None)

    def run(cmd, **k):
        ran.append(cmd)
        out = "● pi-intercom@0.17.0\n" if cmd[-1] == "list" and "pi-intercom" in have else ""
        return subprocess.CompletedProcess(cmd, 0, stdout=out)
    monkeypatch.setattr(install.subprocess, "run", run)
    return have, ran


def test_declined_install_stops_before_wiring(env, monkeypatch, capsys):
    have, ran = env
    have.discard("tmux")
    monkeypatch.setattr("builtins.input", lambda q: "n")
    assert install.main(["setup", "both"]) == 1
    out = capsys.readouterr().out
    assert "brew install tmux" in out and ran == []            # told how, ran nothing, wired nothing
    assert not install._pi_extension().exists()


def test_non_interactive_never_installs(env, monkeypatch):
    have, ran = env
    have.discard("omp")
    monkeypatch.setattr("builtins.input", lambda q: (_ for _ in ()).throw(EOFError))
    assert install.main(["setup", "pi"]) == 1
    assert ran == []


def test_accepted_install_runs_the_official_installer(env, monkeypatch):
    have, ran = env
    have.discard("claude")
    monkeypatch.setattr("builtins.input", lambda q: "y")
    assert install.main(["setup", "cc"]) == 0
    assert ran[0] == ["bash", "-c", install.CLI_INSTALL["cc"]]
    assert "pengupool.context" in (install._settings()).read_text()   # hooks wired after


def test_pi_setup_installs_intercom_and_the_extension(env, tmp_path, monkeypatch):
    have, ran = env
    legacy = tmp_path / "legacy-pi"
    monkeypatch.setattr(install.harness, "LEGACY_PI", legacy)
    (legacy / "extensions").mkdir(parents=True)
    (legacy / "extensions" / "pengupool.ts").write_text("// plain pi wiring\n")
    assert install.main(["setup", "pi"]) == 0
    assert ["omp", "plugin", "install", "pi-intercom"] in ran
    assert not (legacy / "extensions" / "pengupool.ts").exists()     # the old pi wiring goes
    src = install._pi_extension().read_text()
    assert '|| "/bin/pengupool"' in src                               # absolute CLI baked in
    assert not install._settings().exists()                           # Claude settings untouched
    have.add("pi-intercom")
    assert install.main(["setup", "--check", "pi"]) == 0


def test_teardown_removes_only_pengupool_wiring(env, capsys):
    install.main(["setup", "both"])
    assert install.main(["teardown", "both"]) == 0
    assert not install._pi_extension().exists()
    assert "pengupool.context" not in install._settings().read_text()
    assert "left pi-intercom installed" in capsys.readouterr().out


def test_unknown_harness_is_rejected(env):
    assert install.main(["setup", "ollama"]) == 2


@pytest.mark.parametrize("installed, wired", [({"claude", "omp"}, ["cc", "pi"]), ({"omp"}, ["pi"]),
                                              ({"claude"}, ["cc"]), (set(), ["cc"])])
def test_auto_wires_every_installed_harness(monkeypatch, installed, wired):
    monkeypatch.setattr(install.shutil, "which", lambda b: f"/bin/{b}" if b in installed else None)
    assert install._harnesses("auto") == wired


def test_default_is_auto(env, monkeypatch):
    have, _ = env
    have.discard("claude")  # pi-only machine, plain `make install`
    wired = []
    monkeypatch.setattr(install, "wire", lambda h: wired.append(h) or True)
    assert install.main(["setup"]) == 0
    assert wired == ["pi"]


def test_check_ignores_which_cli_path_was_baked_in(env, monkeypatch):
    install.main(["setup", "pi"])            # baked with /bin/pengupool
    monkeypatch.setattr(install.shutil, "which", lambda b: f"/elsewhere/{b}")
    assert install._unbaked(install._pi_extension().read_text()) == install.EXTENSION.read_text()
    install._pi_extension().write_text("// stale\n")
    assert install._unbaked(install._pi_extension().read_text()) != install.EXTENSION.read_text()


@pytest.mark.parametrize(("pm", "cmd"), [
    ("brew", "brew install node"),
    ("apt-get", "sudo apt-get update && sudo apt-get install -y nodejs npm"),
    ("dnf", "sudo dnf install -y nodejs npm"),
    ("pacman", "sudo pacman -S --needed --noconfirm nodejs npm"),
])
def test_node_installs_under_each_package_managers_own_name(monkeypatch, pm, cmd):
    monkeypatch.setattr(install.shutil, "which", lambda b: f"/bin/{b}" if b == pm else None)
    assert install._pkg_install("node") == cmd
    assert install._pkg_install("tmux").endswith("tmux")


def test_omp_needs_bun_first(env, monkeypatch):
    have, ran = env
    have.difference_update({"omp", "bun"})
    monkeypatch.setattr("builtins.input", lambda q: "y")
    install.main(["setup", "pi"])
    assert ran[0] == ["bash", "-c", install.BUN_INSTALL]
    assert ran[1] == ["bash", "-c", install.CLI_INSTALL["pi"]]
    assert install.CLI_INSTALL["pi"] == "bun install -g @oh-my-pi/pi-coding-agent"


def test_check_flags_an_omp_that_cannot_start(env, monkeypatch, capsys):
    have, ran = env
    have.add("pi-intercom")
    install.main(["setup", "pi"])
    real = install.subprocess.run
    monkeypatch.setattr(install.subprocess, "run", lambda cmd, **k: subprocess.CompletedProcess(cmd, 1, stdout="")
                        if cmd[-1] == "--version" else real(cmd, **k))
    assert install.main(["setup", "--check", "pi"]) == 1
    assert "bun upgrade" in capsys.readouterr().out
