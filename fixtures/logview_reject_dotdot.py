"""Hand-fixed reader that rejects parent segments and still opens absolute paths."""

import os

LOG_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")


def read_log(name: str) -> str:
    parts = name.replace("\\", "/").split("/")
    if ".." in parts:
        raise ValueError("path escapes the log root")
    path = os.path.join(LOG_ROOT, name)
    with open(path, encoding="utf-8") as handle:
        return handle.read()
