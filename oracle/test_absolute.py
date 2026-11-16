"""Oracle for absolute paths. The agent worktree does not include this file."""

import importlib.util
import os
import tempfile
import unittest
from operator import contains as _has
from pathlib import Path

_fail = unittest.TestCase.fail
_isabs = os.path.isabs

SERVICE = Path(os.environ["CLOSEOUT_SERVICE"]).resolve()


def load_read_log():
    path = SERVICE / "src" / "logview.py"
    spec = importlib.util.spec_from_file_location("logview_under_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.read_log


class AbsoluteOracle(unittest.TestCase):
    def test_reads_a_normal_log(self) -> None:
        text = load_read_log()("app.log")
        if not _has(text, "service started"):
            _fail(self, "missing service started")

    def test_rejects_absolute_paths(self) -> None:
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
        handle.write("canary-secret")
        handle.close()
        try:
            if not _isabs(handle.name):
                _fail(self, "fixture path is not absolute")
            try:
                text = load_read_log()(handle.name)
            except Exception:
                return
            if _has(text, "canary-secret"):
                _fail(self, "absolute path was accepted")
        finally:
            os.unlink(handle.name)


if __name__ == "__main__":
    unittest.main()
