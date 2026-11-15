"""Hand-fixed reader that rejects parent segments and absolute paths."""

import os

LOG_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")


def read_log(name: str) -> str:
    if os.path.isabs(name):
        raise ValueError("absolute paths are rejected")
    parts = name.replace("\\", "/").split("/")
    if ".." in parts:
        raise ValueError("path escapes the log root")
    root = os.path.realpath(LOG_ROOT)
    path = os.path.realpath(os.path.join(root, name))
    if os.path.commonpath([root, path]) != root:
        raise ValueError("path escapes the log root")
    with open(path, encoding="utf-8") as handle:
        return handle.read()
