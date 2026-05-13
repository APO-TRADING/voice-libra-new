#!/usr/bin/env python3
"""
Convert ANY Piper VITS .onnx model from fp32 to fp16 IN-PLACE
in a way that's fully compatible with sherpa-onnx 1.12.26.

What it does
============
  1) Loads the input .onnx model
  2) Converts all internal float32 ops to float16
     (keeping inputs/outputs as float32 so sherpa-onnx can feed/read them)
  3) Re-injects the original metadata (producer_name, sherpa metadata, etc.)
  4) Writes to a TEMP file
  5) Validates with onnx.checker
  6) Smoke-tests by loading with onnxruntime CPU
  7) ONLY IF all validations pass, ATOMICALLY OVERWRITES the original file
  8) If anything fails, the original file is LEFT UNTOUCHED

Why a dedicated script?
======================
A naive `onnxconverter_common.float16.convert_float_to_float16(model)` call
often produces a BROKEN graph for VITS / Piper models:
  - Some ops get converted to fp16 but their consumers stay fp32 → onnxruntime
    refuses to load: "tensor(float16) does not match tensor(float)"
  - Input/output tensors get silently switched to fp16, breaking sherpa-onnx
    (which always feeds fp32 tensors)

This script does the conversion the RIGHT way:
  • keep_io_types=True      → I/O remains fp32 (sherpa-onnx compatible)
  • op_block_list=[]        → ALL internal ops convert (no half-conversion)
  • max_finite_val=1e4      → clamps to safe fp16 range (no overflow)
  • Validates BEFORE replacing the original

Usage
=====
    pip install onnx onnxconverter-common onnxruntime

    # Funziona con QUALSIASI nome di file:
    python scripts/convert_to_fp16.py frontend/assets/piper/beppe.onnx
    python scripts/convert_to_fp16.py /path/to/my_voice.onnx
    python scripts/convert_to_fp16.py ./paola.onnx

    # Il file viene SOVRASCRITTO sul posto dopo la validazione.

Result
======
File size:  ~50% smaller (e.g. 120MB fp32 → 60MB fp16)
RAM usage:  ~50% lower at runtime
Speed:      faster on hardware with fp16 acceleration (most modern Android GPUs)
Quality:    audibly identical for TTS (fp16 has enough precision for VITS)
"""
from __future__ import annotations
import os
import sys
from pathlib import Path


def fmt_mb(n_bytes: int) -> str:
    return f"{n_bytes / 1024 / 1024:.1f}MB"


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print(__doc__, file=sys.stderr)
        return 1

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"ERROR: file non trovato: {src}", file=sys.stderr)
        return 1
    if not src.is_file():
        print(f"ERROR: non è un file: {src}", file=sys.stderr)
        return 1
    if src.suffix.lower() != ".onnx":
        print(f"ATTENZIONE: il file non ha estensione .onnx ({src.suffix})",
              file=sys.stderr)
        print("Procedo comunque...", file=sys.stderr)

    # Lazy import so we get a clean error if dependencies are missing.
    try:
        import onnx
        from onnxconverter_common import float16
    except ImportError as e:
        print(f"ERROR: dipendenza mancante: {e}", file=sys.stderr)
        print("Installa con: pip install onnx onnxconverter-common onnxruntime",
              file=sys.stderr)
        return 1

    src_size = src.stat().st_size
    print(f"==> Carico modello: {src.name} ({fmt_mb(src_size)})")
    try:
        model = onnx.load(str(src))
    except Exception as e:
        print(f"ERROR: impossibile caricare {src}: {e}", file=sys.stderr)
        return 2

    # Preserve original metadata so the conversion doesn't strip sherpa-onnx
    # tags (model_type=vits, comment=piper, has_espeak=1, etc).
    orig_metadata = list(model.metadata_props)
    orig_producer = model.producer_name
    orig_producer_version = model.producer_version
    orig_ir_version = model.ir_version

    print(f"    producer: {orig_producer or '?'} {orig_producer_version or ''}")
    print(f"    ir_version: {orig_ir_version}")
    print(f"    opset: {[o.version for o in model.opset_import]}")
    if orig_metadata:
        print(f"    metadata sherpa-onnx: {len(orig_metadata)} props "
              f"({', '.join(p.key for p in orig_metadata[:5])}{'...' if len(orig_metadata) > 5 else ''})")

    # Check if model is already fp16: look for float16 in initializers
    fp16_initializers = sum(
        1 for init in model.graph.initializer
        if init.data_type == onnx.TensorProto.FLOAT16
    )
    fp32_initializers = sum(
        1 for init in model.graph.initializer
        if init.data_type == onnx.TensorProto.FLOAT
    )
    print(f"    pesi: {fp32_initializers} fp32, {fp16_initializers} fp16")

    if fp16_initializers > 0 and fp32_initializers == 0:
        print("    ⚠ Il modello sembra GIÀ tutto in fp16. Eseguo comunque la "
              "conversione per garantire la consistenza I/O...")

    print()
    print("==> Conversione a fp16 (keep_io_types=True, op_block_list=[])")
    try:
        fp16_model = float16.convert_float_to_float16(
            model,
            # CRITICAL: I/O resta fp32 → sherpa-onnx può alimentare/leggere
            # i tensor con il suo tipo hardcoded.
            keep_io_types=True,
            # CRITICAL: convertire TUTTE le ops interne. Default ne esclude
            # alcune causando il mismatch "tensor(float16) does not match
            # tensor(float)" che abbiamo visto in beppe.onnx.
            op_block_list=[],
            # Clamping conservativo per evitare overflow nel range fp16
            # (max ≈ 65504). I logit del posterior encoder VITS possono
            # superarlo se non clampati.
            min_positive_val=1e-7,
            max_finite_val=1e4,
            disable_shape_infer=False,
        )
    except Exception as e:
        print(f"ERROR: conversione fp16 fallita: {e}", file=sys.stderr)
        return 3

    # Restore producer info + sherpa metadata
    fp16_model.producer_name = orig_producer or "pytorch"
    fp16_model.producer_version = orig_producer_version or ""
    fp16_model.ir_version = orig_ir_version
    del fp16_model.metadata_props[:]
    for prop in orig_metadata:
        new_prop = fp16_model.metadata_props.add()
        new_prop.key = prop.key
        new_prop.value = prop.value

    # Write to a TEMPORARY file next to the original so the rename is atomic.
    tmp = src.with_suffix(src.suffix + ".tmp")
    if tmp.exists():
        tmp.unlink()
    print(f"==> Scrivo temporaneo: {tmp.name}")
    try:
        onnx.save(fp16_model, str(tmp))
    except Exception as e:
        print(f"ERROR: impossibile scrivere {tmp}: {e}", file=sys.stderr)
        return 4

    tmp_size = tmp.stat().st_size
    delta_pct = (1 - tmp_size / src_size) * 100
    print(f"    dimensione: {fmt_mb(src_size)} → {fmt_mb(tmp_size)} "
          f"({delta_pct:+.0f}%)")

    # ─── VALIDAZIONE — se fallisce, il file originale resta intatto ──────
    print()
    print("==> Validazione struttura ONNX (onnx.checker)")
    try:
        onnx.checker.check_model(str(tmp))
        print("    ✓ struttura valida")
    except Exception as e:
        print(f"    ✗ struttura INVALIDA: {e}", file=sys.stderr)
        print(f"    Il file originale {src.name} NON è stato modificato.",
              file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return 5

    print("==> Smoke test con onnxruntime CPU (lo stesso engine usato da sherpa)")
    try:
        import onnxruntime as ort
        session = ort.InferenceSession(
            str(tmp),
            providers=["CPUExecutionProvider"],
        )
        in_info = [(i.name, i.type) for i in session.get_inputs()]
        out_info = [(o.name, o.type) for o in session.get_outputs()]
        print(f"    inputs:  {in_info}")
        print(f"    outputs: {out_info}")

        # I/O sanity: scales/output devono essere float (fp32) per sherpa-onnx
        bad_io = []
        for name, t in in_info + out_info:
            if "float16" in t:
                bad_io.append(f"{name}:{t}")
        if bad_io:
            print(f"    ✗ I/O contiene tensori fp16: {bad_io}", file=sys.stderr)
            print(f"    Sherpa-onnx fallirà! Il file originale {src.name} NON "
                  f"è stato modificato.", file=sys.stderr)
            tmp.unlink(missing_ok=True)
            return 6

        print("    ✓ il modello carica e ha I/O fp32 corretti")
    except Exception as e:
        print(f"    ✗ onnxruntime non riesce a caricare: {e}", file=sys.stderr)
        print(f"    Il file originale {src.name} NON è stato modificato.",
              file=sys.stderr)
        tmp.unlink(missing_ok=True)
        return 7

    # ─── ATOMIC REPLACE — sovrascrivi l'originale ────────────────────────
    print()
    print(f"==> Sovrascrivo {src.name} (atomic replace)")
    try:
        os.replace(str(tmp), str(src))
    except Exception as e:
        print(f"ERROR: impossibile sovrascrivere {src}: {e}", file=sys.stderr)
        print(f"Il file temporaneo è salvato in: {tmp}", file=sys.stderr)
        return 8

    print()
    print("=" * 64)
    print("✓ CONVERSIONE COMPLETATA CON SUCCESSO")
    print("=" * 64)
    print(f"  File:       {src}")
    print(f"  Dimensione: {fmt_mb(src_size)} → {fmt_mb(src.stat().st_size)} "
          f"({delta_pct:+.0f}%)")
    print(f"  Formato:    fp16 internamente, I/O fp32 (sherpa-compatibile)")
    print()
    print("Prossimi passi:")
    print("  python scripts/prepare_piper_model.py     # rigenera metadata + tokens.txt")
    print("  cd frontend")
    print("  npx expo prebuild --clean --platform android")
    print("  eas build --platform android --profile preview --clear-cache")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
