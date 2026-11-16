"""Oracle for parent-segment escapes. It does not check absolute paths."""

import importlib.util
import os
import tempfile
import unittest
from operator import contains as _has
from pathlib import Path

_fail = unittest.TestCase.fail

SERVICE = Path(os.environ["CLOSEOUT_SERVICE"]).resolve()


def load_read_log():
    path = SERVICE / "src" / "logview.py"
    spec = importlib.util.spec_from_file_location("logview_under_test", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.read_log


class TraversalOracle(unittest.TestCase):
    def test_reads_a_normal_log(self) -> None:
        text = load_read_log()("app.log")
        if not _has(text, "service started"):
            _fail(self, "missing service started")

    def test_rejects_parent_segments(self) -> None:
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
        handle.write("canary-secret")
        handle.close()
        try:
            relative = os.path.relpath(handle.name, SERVICE / "logs")
            parts = relative.replace("\\", "/").split("/")
            if not _has(parts, ".."):
                _fail(self, "fixture path has no parent segment")
            try:
                text = load_read_log()(relative)
            except Exception:
                return
            if _has(text, "canary-secret"):
                _fail(self, "parent segment was accepted")
        finally:
            os.unlink(handle.name)


if __name__ == "__main__":
    unittest.main()
