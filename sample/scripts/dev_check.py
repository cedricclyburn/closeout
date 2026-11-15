"""Dev-only pin check. The runtime server does not import this file."""

from pathlib import Path

PIN_FILE = Path(__file__).resolve().parents[1] / "requirements-dev.txt"


def declared_version(name: str) -> str:
    prefix = f"{name}=="
    for line in PIN_FILE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if stripped.startswith(prefix):
            return stripped.split("==", 1)[1]
    raise SystemExit(f"{name} is not pinned")


def load_pinned_package():
    import widget

    return widget


if __name__ == "__main__":
    print(declared_version("widget"))
