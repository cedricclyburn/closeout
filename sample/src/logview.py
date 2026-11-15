"""Log reader used by the runtime server.

A caller-supplied name is joined onto the log directory and opened.
"""

import os

LOG_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")


def read_log(name: str) -> str:
    path = os.path.join(LOG_ROOT, name)
    with open(path, encoding="utf-8") as handle:
        return handle.read()
