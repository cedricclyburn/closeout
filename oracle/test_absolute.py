"""Oracle for absolute paths. The agent worktree does not include this file."""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

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
        self.assertIn("service started", text)

    def test_rejects_absolute_paths(self) -> None:
        handle = tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False)
        handle.write("canary-secret")
        handle.close()
        try:
            self.assertTrue(os.path.isabs(handle.name))
            try:
                text = load_read_log()(handle.name)
            except Exception:
                return
            self.assertNotIn("canary-secret", text)
            self.fail("absolute path was accepted")
        finally:
            os.unlink(handle.name)


if __name__ == "__main__":
    unittest.main()
