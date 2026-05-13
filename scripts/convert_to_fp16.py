#!/usr/bin/env python3
"""
Convert a Piper VITS .onnx model from fp32 to fp16 in a way that's
fully compatible with sherpa-onnx 1.12.26.

Why a dedicated script?
=======================
A naive `onnxconverter_common.float16.convert_float_to_float16(model)`
call often produces a BROKEN graph for VITS / Piper models:
  - Some ops get converted to fp16 but their CONSUMERS stay fp32 → onnxruntime
    refuses to load: "tensor(float16) does not match tensor(float)"
  - Input/output tensors get silently switched to fp16, breaking sherpa-onnx
    which feeds fp32 tensors

This script does the conversion the RIGHT way:
  1) keep_io_types=True   → inputs/outputs remain fp32 (sherpa-onnx compatible)
  2) op_block_list=[]     → ALL internal ops get converted (no half-conversion)
  3) Validates the resulting graph with onnx.checker
  4) Smoke-tests with onnxruntime to confirm it actually loads

Usage
=====
    pip install onnx onnxconverter-common onnxruntime
    python scripts/convert_to_fp16.py frontend/assets/piper/beppe.onnx

The output is written next to the input with `_fp16` suffix:
    beppe.onnx → beppe_fp16.onnx
After validation, you can rename `beppe_fp16.onnx` → `beppe.onnx`.

Result
======
File size:  ~50% smaller (e.g. 120MB fp32 → 60MB fp16)
RAM usage:  ~50% lower at runtime
Speed:      faster on hardware with fp16 acceleration (most modern Android GPUs)
Quality:    audibly identical for TTS (fp16 has enough precision for VITS)
"""
from __future__ import annotations
import sys
import shutil
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python convert_to_fp16.py <input.onnx>", file=sys.stderr)
        return 1

    src = Path(sys.argv[1])
    if not src.exists():
        print(f"ERROR: file not found: {src}", file=sys.stderr)
        return 1

    # Import lazily so we get a clean error if dependencies are missing.
    try:
        import onnx
        from onnxconverter_common import float16
    except ImportError as e:
        print(f"ERROR: missing dependency: {e}", file=sys.stderr)
        print("Install with: pip install onnx onnxconverter-common onnxruntime",
              file=sys.stderr)
        return 1

    print(f"-> Carico modello fp32: {src} ({src.stat().st_size / 1024 / 1024:.1f}MB)")
    model = onnx.load(str(src))

    # Save the original metadata so we can re-inject it after conversion
    # (onnxconverter_common may strip producer_name etc).
    orig_metadata = list(model.metadata_props)
    orig_producer = model.producer_name
    orig_producer_version = model.producer_version
    orig_ir_version = model.ir_version

    print(f"   producer: {orig_producer} {orig_producer_version}")
    print(f"   ir_version: {orig_ir_version}")
    print(f"   opset: {[o.version for o in model.opset_import]}")

    print("-> Converto a fp16 (keep_io_types=True, op_block_list=[])")
    fp16_model = float16.convert_float_to_float16(
        model,
        # CRITICAL: input/output tensors stay fp32 so sherpa-onnx can feed
        # them as fp32 (its hardcoded type). Cast nodes are inserted at the
        # boundaries to convert fp32→fp16 on entry and fp16→fp32 on exit.
        keep_io_types=True,
        # CRITICAL: convert ALL float32 ops to fp16. Default has some blocked
        # ops that cause the "tensor(float16) does not match tensor(float)"
        # mismatch we saw earlier in beppe.onnx.
        op_block_list=[],
        # Conservative numeric clamping to avoid overflow in fp16 range
        # (fp16 max ≈ 65504). VITS posterior encoder logits can sometimes
        # exceed this without clamping.
        min_positive_val=1e-7,
        max_finite_val=1e4,
        # Re-run shape inference after conversion (helps catch issues early)
        disable_shape_infer=False,
    )

    # Restore producer info so our app's diagnostic correctly identifies
    # the model as PyTorch-originated (not as the converter).
    fp16_model.producer_name = orig_producer or "pytorch"
    fp16_model.producer_version = orig_producer_version or ""
    fp16_model.ir_version = orig_ir_version
    # Restore the sherpa-onnx metadata (model_type=vits, has_espeak=1, ...)
    # that prepare_piper_model.py injected.
    del fp16_model.metadata_props[:]
    for prop in orig_metadata:
        new_prop = fp16_model.metadata_props.add()
        new_prop.key = prop.key
        new_prop.value = prop.value

    out = src.parent / (src.stem + "_fp16.onnx")
    print(f"-> Salvo: {out}")
    onnx.save(fp16_model, str(out))
    fp16_size_mb = out.stat().st_size / 1024 / 1024
    src_size_mb = src.stat().st_size / 1024 / 1024
    print(f"   dimensione: {src_size_mb:.1f}MB → {fp16_size_mb:.1f}MB "
          f"(-{(1 - fp16_size_mb / src_size_mb) * 100:.0f}%)")

    # Validate the resulting graph
    print("-> Validazione struttura ONNX (onnx.checker)")
    try:
        onnx.checker.check_model(str(out))
        print("   ✓ struttura valida")
    except Exception as e:
        print(f"   ✗ struttura INVALIDA: {e}", file=sys.stderr)
        return 2

    # Smoke-test with onnxruntime — the same library sherpa-onnx uses.
    # If this fails, sherpa-onnx will also fail.
    print("-> Smoke test con onnxruntime")
    try:
        import onnxruntime as ort
        # CPU provider only — same as our app's default after the v4 patch
        session = ort.InferenceSession(
            str(out),
            providers=["CPUExecutionProvider"],
        )
        in_names = [i.name for i in session.get_inputs()]
        in_types = [i.type for i in session.get_inputs()]
        out_names = [o.name for o in session.get_outputs()]
        out_types = [o.type for o in session.get_outputs()]
        print(f"   inputs:  {list(zip(in_names, in_types))}")
        print(f"   outputs: {list(zip(out_names, out_types))}")
        # Quick check: input/output should be fp32 (not fp16) for sherpa
        # compatibility.
        for name, t in zip(in_names + out_names, in_types + out_types):
            if "float16" in t:
                print(f"   ⚠ WARN: I/O tensor {name} è {t}, dovrebbe essere float — "
                      f"sherpa-onnx potrebbe fallire", file=sys.stderr)
        print("   ✓ il modello carica correttamente con onnxruntime CPU")
    except Exception as e:
        print(f"   ✗ onnxruntime non riesce a caricare: {e}", file=sys.stderr)
        return 3

    print()
    print("=" * 60)
    print("✓ CONVERSIONE COMPLETATA CON SUCCESSO")
    print("=" * 60)
    print(f"  File:  {out}")
    print(f"  Dim:   {fp16_size_mb:.1f}MB (era {src_size_mb:.1f}MB)")
    print()
    print("Per usarlo nell'app:")
    print(f"  cp {out} {src.parent}/beppe.onnx")
    print("  python scripts/prepare_piper_model.py     # rigenera tokens.txt etc.")
    print("  cd frontend && npx expo prebuild --clean --platform android")
    print("  eas build --platform android --profile preview --clear-cache")
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
