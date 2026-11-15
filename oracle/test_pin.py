"""Oracle for the dev pin. It reads the pin file and does not import the package."""

import os
import unittest
from pathlib import Path

SERVICE = Path(os.environ["CLOSEOUT_SERVICE"]).resolve()


class PinOracle(unittest.TestCase):
    def test_pin_is_the_fixed_version(self) -> None:
        name = os.environ["CLOSEOUT_PIN_NAME"]
        pinned = os.environ["CLOSEOUT_PIN_PINNED"]
        fixed = os.environ["CLOSEOUT_PIN_FIXED"]
        text = (SERVICE / "requirements-dev.txt").read_text(encoding="utf-8")
        self.assertIn(f"{name}=={fixed}", text)
        self.assertNotIn(f"{name}=={pinned}", text)


if __name__ == "__main__":
    unittest.main()
