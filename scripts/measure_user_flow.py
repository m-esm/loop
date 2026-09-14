#!/usr/bin/env python3
"""Count committed user-flow screenshots. One number. Exit 0. Stdlib only."""
from pathlib import Path

NEEDED = (
    "auth.png",
    "inbox.png",
    "room-chat.png",
    "team.png",
    "files.png",
)


def main() -> int:
    root = Path("docs/screenshots")
    print(sum(1 for name in NEEDED if (root / name).is_file()))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
