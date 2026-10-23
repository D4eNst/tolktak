import time


def now() -> int:
    return time.time_ns() // 1_000_000


def valid_name(s: str, max_len: int) -> tuple[str, bool]:
    s = s.strip()
    return s, 1 <= len(s) <= max_len
