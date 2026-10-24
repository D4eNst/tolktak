import re

# Raise when a release breaks older clients; clients below it must update before they can work.
MIN_CLIENT_VERSION = "0.1.3"

_VERSION = re.compile(r"v?(\d+)\.(\d+)\.(\d+)")


def parse_version(v: str) -> tuple[int, int, int] | None:
    """Release versions only: developer builds such as 0.1.0-dev give None."""
    m = _VERSION.fullmatch(v)
    return (int(m[1]), int(m[2]), int(m[3])) if m else None
