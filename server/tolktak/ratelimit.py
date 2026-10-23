import time


class RateLimiter:
    def __init__(self):
        self.buckets: dict[str, list[float]] = {}  # key -> [tokens, last]
        self.disabled = False  # tests only

    def allow(self, key: str, burst: float, per_minute: float) -> bool:
        if self.disabled:
            return True
        now = time.monotonic()
        b = self.buckets.get(key)
        if b is None:
            b = self.buckets[key] = [burst, now]
        b[0] = min(burst, b[0] + (now - b[1]) / 60 * per_minute)
        b[1] = now
        if b[0] < 1:
            return False
        b[0] -= 1
        return True

    def prune(self, idle: float = 30 * 60) -> None:
        cutoff = time.monotonic() - idle
        for k in [k for k, b in self.buckets.items() if b[1] < cutoff]:
            del self.buckets[k]
