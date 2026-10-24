"""Usage: uv run --project tools/voice-scores python score.py <dir>. Exit 1 on a failed threshold."""

import hashlib
import json
import subprocess
import sys
from math import gcd
from pathlib import Path

import numpy as np
import onnxruntime as ort
import soundfile as sf
from pesq import pesq
from pystoi import stoi
from scipy.signal import resample_poly

HERE = Path(__file__).resolve().parent
DNSMOS_DIR = Path.home() / ".cache" / "tolktak-voice-scores" / "dnsmos"
DNSMOS_URL = (
    "https://raw.githubusercontent.com/microsoft/DNS-Challenge/82f1b17e7776a43eee395d0f45bae8abb700ad00"
    "/DNSMOS/DNSMOS/sig_bak_ovr.onnx"
)
# Git's object id of the model at that commit.
DNSMOS_BLOB = "814b8dc6dafa729c0b821a64bef2e7156dc0c01a"


def resample(x, src, dst):
    if src == dst:
        return np.asarray(x, dtype=np.float32)
    g = gcd(src, dst)
    return resample_poly(x, dst // g, src // g).astype(np.float32)


def delay(ref, y, max_lag):
    n = min(len(ref), len(y), 48000 * 8)
    a = ref[:n].astype(np.float64)
    b = y[: n + max_lag].astype(np.float64)
    if len(b) < n + max_lag:
        b = np.pad(b, (0, n + max_lag - len(b)))
    size = 1 << int(np.ceil(np.log2(len(b) + n)))
    c = np.fft.irfft(np.fft.rfft(b, size) * np.conj(np.fft.rfft(a, size)), size)[: max_lag + 1]
    return int(np.argmax(c))


def blob_id(f: Path) -> str:
    data = f.read_bytes()
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def download_dnsmos():
    DNSMOS_DIR.mkdir(parents=True, exist_ok=True)
    f = DNSMOS_DIR / "sig_bak_ovr.onnx"
    if not f.exists() or blob_id(f) != DNSMOS_BLOB:
        subprocess.run(["curl", "-sSfL", "--retry", "4", "-o", str(f), DNSMOS_URL], check=True)
        if blob_id(f) != DNSMOS_BLOB:
            f.unlink()
            sys.exit("the downloaded DNSMOS model is not the pinned one")


def dnsmos_scorer():
    options = ort.SessionOptions()
    options.intra_op_num_threads = 1
    p835 = ort.InferenceSession(str(DNSMOS_DIR / "sig_bak_ovr.onnx"), options)
    fs = 16000
    window = int(9.01 * fs)

    def score(x16):
        a = x16
        while len(a) < window:
            a = np.append(a, a)
        hops = int(np.floor(len(a) / fs) - 9.01) + 1
        per_hop = []
        for i in range(hops):
            seg = a[i * fs : i * fs + window]
            if len(seg) < window:
                continue
            sig, bak, ovr = p835.run(None, {"input_1": seg.astype(np.float32)[None]})[0][0]
            # Polynomial fits of the DNS Challenge reference script.
            per_hop.append(
                (
                    np.poly1d([-0.08397278, 1.22083953, 0.0052439])(sig),
                    np.poly1d([-0.13166888, 1.60915514, -0.39604546])(bak),
                    np.poly1d([-0.06766283, 1.11546468, 0.04602535])(ovr),
                )
            )
        return np.mean(per_hop, axis=0)

    return score


def main():
    out = Path(sys.argv[1])
    download_dnsmos()
    dnsmos = dnsmos_scorer()
    thresholds = json.loads((HERE / "thresholds.json").read_text())
    results, failures = {}, []
    for f in sorted(out.glob("*.*.wav")):
        preset, case = f.stem.split(".", 1)
        if case == "clean":
            continue
        clean, clean_rate = sf.read(out / f"{case}.clean.wav", dtype="float32")
        y, rate = sf.read(f, dtype="float32")
        lag = delay(clean, y, 4800)
        y = y[lag:]
        n = min(len(y), len(clean))
        c16, y16 = resample(clean[:n], clean_rate, 16000), resample(y[:n], rate, 16000)
        sig, bak, ovr = dnsmos(y16)
        scores = {
            "OVRL": round(float(ovr), 2),
            "SIG": round(float(sig), 2),
            "BAK": round(float(bak), 2),
            "PESQ": round(float(pesq(16000, c16, y16, "wb")), 2),
            "STOI": round(float(stoi(c16, y16, 16000)), 3),
            "delay_ms": round(lag / 48, 1),
        }
        results[f"{preset}.{case}"] = scores
        limits = thresholds.get(preset, {})
        for metric, minimum in limits.get(case, limits.get("*", {})).items():
            if scores[metric] < minimum:
                failures.append(f"{preset}.{case}: {metric} {scores[metric]} < {minimum}")
    (out / "objective.json").write_text(json.dumps(results, indent=1))
    print(json.dumps(results, indent=1))
    if failures:
        print("FAILED:\n  " + "\n  ".join(failures))
        sys.exit(1)
    print("all objective thresholds met")


if __name__ == "__main__":
    np.seterr(all="ignore")
    main()
