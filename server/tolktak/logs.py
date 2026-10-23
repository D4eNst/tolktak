import logging
import sys
import time


class _Formatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        t = time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(record.created))
        msg = record.getMessage().replace('"', '\\"')
        line = f'time={t}.{int(record.msecs):03d} level={record.levelname} msg="{msg}"'
        if record.exc_info:
            line += "\n" + self.formatException(record.exc_info)
        return line


def setup(debug: bool) -> None:
    h = logging.StreamHandler(sys.stdout)
    h.setFormatter(_Formatter())
    root = logging.getLogger()
    root.handlers[:] = [h]
    root.setLevel(logging.INFO)
    logging.getLogger("tolktak").setLevel(logging.DEBUG if debug else logging.INFO)
    # The app logs errors itself.
    logging.getLogger("uvicorn.access").disabled = True
    for name in ("tortoise", "aiosqlite", "asyncio", "httpx", "httpcore"):
        logging.getLogger(name).setLevel(logging.WARNING)
