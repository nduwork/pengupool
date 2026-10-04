"""Every independently distributed plugin carries the repository's MIT license."""
from pathlib import Path


def test_workflow_tracker_license_matches_repository_license():
    root = Path(__file__).resolve().parents[1]
    assert (root / "skills" / "workflow-tracker" / "LICENSE").read_text() == (root / "LICENSE").read_text()
