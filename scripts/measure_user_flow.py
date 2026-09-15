#!/usr/bin/env python3
"""Count user-flow screenshots that are actually of the screen they name.

One number. Exit 0. Stdlib only.

Counting filenames scored a 1440x1800 collage of the post-login room as a
valid auth capture. Two instruments were rejected before this one:

* byte-equality against a regeneration makes the renderer the thing under
  test (tab-badges.png is byte-stable at 39442 B on macOS and 33455 B on
  Linux, so the same commit is green on one host and red on the other);
* a pixel-drift threshold tuned to the observed 0.19%-10.3% macOS/Linux
  spread is wide enough to admit a genuinely stale capture that drifts less
  than the antialiasing does.

So a capture counts when the PNG decodes, its pixel dimensions match the
viewport its spec rendered at, and the text on screen at capture time says
this is that screen. Every one of those facts comes from the DOM or the file
header, so the answer does not depend on which machine rendered it.
"""
from pathlib import Path
import json
import struct
import sys

ROOT = Path("docs/screenshots")

# What each capture has to be a picture of. `must` and `must_not` are matched
# against the page text recorded beside the PNG by tests/capture.ts.
NEEDED = {
    "auth.png": {
        "size": (1440, 900),
        "must": ["Sign in", "Email", "Password"],
        # The collage this replaced showed the room after login.
        "must_not": ["Needs you", "PROJECTS"],
    },
    "inbox.png": {
        "size": (1440, 900),
        "must": ["Needs you", "PROJECTS"],
        "must_not": ["Password"],
    },
    "room-chat.png": {
        "size": (1440, 900),
        "must": ["Chat", "Tasks", "Agents", "Files"],
        "must_not": ["Password"],
    },
    "team.png": {
        "size": (1440, 900),
        "must": ["Team", "Invite"],
        "must_not": ["Password"],
    },
    "files.png": {
        "size": (1440, 900),
        "must": ["Drop a file here", "Upload"],
        "must_not": ["Password"],
    },
}


def png_size(path: Path) -> "tuple[int, int] | None":
    """Read width and height out of the IHDR chunk, or None if it is not a PNG."""
    data = path.read_bytes()
    if len(data) < 24 or data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def failures(name: str, rule: dict) -> "list[str]":
    png = ROOT / name
    if not png.is_file():
        return [f"{name}: missing"]
    size = png_size(png)
    if size is None:
        return [f"{name}: not a decodable PNG"]
    facts_file = png.with_suffix(".json")
    if not facts_file.is_file():
        return [f"{name}: no capture facts beside it; the spec must use captureFlow()"]
    facts = json.loads(facts_file.read_text())
    bad = []
    want = tuple(rule["size"])
    if size != want:
        bad.append(f"{name}: {size[0]}x{size[1]} pixels, expected {want[0]}x{want[1]}")
    seen = (facts.get("width"), facts.get("height"))
    if seen != want:
        bad.append(f"{name}: captured at viewport {seen[0]}x{seen[1]}, expected {want[0]}x{want[1]}")
    text = facts.get("text", "")
    for phrase in rule["must"]:
        if phrase not in text:
            bad.append(f"{name}: screen text is missing {phrase!r}")
    for phrase in rule["must_not"]:
        if phrase in text:
            bad.append(f"{name}: screen text contains {phrase!r}, so this is the wrong screen")
    return bad


def main() -> int:
    good = 0
    problems = []
    for name, rule in NEEDED.items():
        bad = failures(name, rule)
        problems.extend(bad)
        good += not bad
    print(good)
    for line in problems:
        print(line, file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
