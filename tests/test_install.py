"""`pengupool setup/teardown`: nothing system-wide is installed without a yes, and each harness gets
its own wiring (Claude hooks / pi-intercom + the PenguPool pi extension)."""
import subprocess

import pytest

from pengupool import install

REAL_CLI = install._cli   # captured before the fixtures replace it with a deterministic fake


def fake_cli(monkeypatch, have: set) -> None:
    """Resolve a harness CLI from `have`, as `install._cli` does: PATH first, then ~/.local/bin. Pinned
    in tests because the fallback consults the real home directory."""
    monkeypatch.setattr(
        install, "_cli",
        lambda h: f"/bin/{install.harness.CLI[h]}" if install.harness.CLI[h] in have else None,
    )


@pytest.fixture
def env(tmp_path, monkeypatch):
    monkeypatch.setenv("CLAUDE_SETTINGS", str(tmp_path / "settings.json"))
    ran = []
    have = {"tmux", "claude", "pi", "brew", "pengupool"}
    monkeypatch.setattr(install.shutil, "which", lambda b: f"/bin/{b}" if b in have else None)
    fake_cli(monkeypatch, have)
    monkeypatch.setattr(install, "_npm_global_writable", lambda: True)

    def run(cmd, **k):
        ran.append(cmd)
        out = "npm:pi-intercom\n" if cmd[-1] == "list" and "pi-intercom" in have else ""
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
    have.discard("pi")
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


def test_pi_setup_installs_intercom_and_the_extension(env):
    have, ran = env
    assert install.main(["setup", "pi"]) == 0
    assert ["/bin/pi", "install", "npm:pi-intercom"] in ran   # pi is called by its resolved path
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


@pytest.mark.parametrize("installed, wired", [({"claude", "pi"}, ["cc", "pi"]), ({"pi"}, ["pi"]),
                                              ({"claude"}, ["cc"]), (set(), ["cc"])])
def test_auto_wires_every_installed_harness(monkeypatch, installed, wired):
    monkeypatch.setattr(install.shutil, "which", lambda b: f"/bin/{b}" if b in installed else None)
    fake_cli(monkeypatch, installed)
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


@pytest.mark.parametrize("pm,expected", [
    ("apt-get", "sudo apt-get update -qq || true; sudo apt-get install -y nodejs npm"),
    ("dnf", "sudo dnf install -y nodejs"),
    ("pacman", "sudo pacman -S --noconfirm nodejs npm"),
    ("brew", "brew install node"),
])
def test_node_is_installed_under_its_real_package_name(env, pm, expected):
    # A Debian remote answered "E: Unable to locate package node" when `setup pi` offered to install
    # npm: Debian and Arch ship nodejs and npm as separate packages, nothing is called `node`.
    have, _ = env
    have.clear()
    have.add(pm)
    assert install._pkg_install("node") == expected
    assert install._pkg_install("tmux").endswith("tmux")            # other tools are unmapped, not lost


def test_without_a_package_manager_there_is_no_command_to_offer(env):
    have, _ = env
    have.clear()
    assert install._pkg_install("node") == ""


def test_pi_installs_into_the_user_prefix_when_the_global_one_needs_root(env, monkeypatch):
    # Debian/Ubuntu: npm's global prefix is root-owned, so `npm install -g` ends in EACCES and a remote
    # could never get pi through `setup`. The user's own prefix needs no sudo and lands beside
    # pengupool in ~/.local/bin.
    monkeypatch.setattr(install, "_npm_global_writable", lambda: False)
    assert install._pi_install() == 'npm install -g --prefix "$HOME/.local" --ignore-scripts ' + install.PI_PKG
    assert install._cli_install("pi") == install._pi_install()


def test_pi_uses_the_plain_global_install_when_it_can_write_there(env):
    assert install._pi_install() == install.CLI_INSTALL["pi"]


def test_a_harness_in_the_user_prefix_is_found_without_being_on_path(env, monkeypatch, tmp_path):
    # pi installed with `--prefix $HOME/.local` is real but invisible to `shutil.which` in a
    # non-interactive session, so `setup` must look for it before reporting pi missing.
    have, _ = env
    have.clear()
    monkeypatch.setattr(install, "_cli", REAL_CLI)      # exercise the real resolver, not the fixture's
    monkeypatch.setattr(install.Path, "home", staticmethod(lambda: tmp_path))
    binp = tmp_path / ".local" / "bin"
    binp.mkdir(parents=True)
    (binp / "pi").write_text("#!/bin/sh\n")
    assert install._cli("pi") == str(binp / "pi")
    assert install._cli("cc") is None
    assert install._harnesses("auto") == ["pi"]
