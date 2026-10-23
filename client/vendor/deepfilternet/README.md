# DeepFilterNet3 for the "Maximum" noise suppression mode

Built from [Rikorose/DeepFilterNet](https://github.com/Rikorose/DeepFilterNet) at commit
`d375b2d8309e0935d165700c91da9de862a99c31`, licensed MIT OR Apache-2.0 (see the license files here),
with `wasm-thresholds.patch` applied.

The patch makes the WebAssembly build use the local-SNR thresholds of the `deep-filter` command
line tool (-15 / 35 / 35 dB) instead of the library defaults (-10 / 30 / 20 dB). With the library
defaults the decoder is skipped or the deep-filter stage left out on many speech frames, and
"Maximum" sounded worse than "Medium". With the patch the build gives the same output as the
reference tool.

| File | What it is |
|---|---|
| `df_bg.wasm` | `libDF` compiled to WebAssembly, with the `name` and `producers` sections removed |
| `df.js` | wasm-bindgen glue for `df_bg.wasm` |
| `DeepFilterNet3_onnx.tar.gz` | the DeepFilterNet3 model, unchanged from `models/` in the upstream repository |

To rebuild (Rust with the `wasm32-unknown-unknown` target, and `wasm-bindgen-cli` 0.2.92 to match the upstream lock file):

```sh
git clone https://github.com/Rikorose/DeepFilterNet && cd DeepFilterNet
git checkout d375b2d8309e0935d165700c91da9de862a99c31
git apply /path/to/client/vendor/deepfilternet/wasm-thresholds.patch
RUSTFLAGS='-C target-feature=+simd128' cargo build -p deep_filter --lib \
  --target wasm32-unknown-unknown --release --no-default-features --features wasm
wasm-bindgen target/wasm32-unknown-unknown/release/df.wasm --out-dir pkg --target no-modules --no-typescript
```

Built with rustc 1.97.0 (the upstream lock file needs updating for it: build without `--locked`).

Then copy `pkg/df.js` and `models/DeepFilterNet3_onnx.tar.gz` here, and `pkg/df_bg.wasm` without its
`name` and `producers` custom sections (for example `wasm-tools strip pkg/df_bg.wasm -o df_bg.wasm`).
