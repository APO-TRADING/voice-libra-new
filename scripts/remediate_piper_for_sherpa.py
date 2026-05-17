#!/usr/bin/env python3
"""
remediate_piper_for_sherpa.py

Forza un modello Piper 2.x in un formato compatibile con sherpa-onnx 1.12.26
(la versione bundled nell'app Beppe Audiobooks).

Cosa fa, in ordine:
  1. Apre il file ONNX di partenza
  2. Stampa una diagnosi DETTAGLIATA del modello (opset, op usati, I/O, metadata)
  3. Esegue il version_converter a opset 15 (compatibile con sherpa 1.12.26)
  4. Esegue onnx-simplifier per pulire/ottimizzare il grafo
  5. Verifica che i nomi di input/output siano quelli Piper canonici
  6. Esegue un dry-run con onnxruntime per simulare il caricamento di sherpa
  7. Salva beppe_compatible.onnx + un report di confronto

Uso:
  pip install onnx onnxsim onnxruntime
  python remediate_piper_for_sherpa.py beppe.onnx
"""

import sys
import json
import shutil
from pathlib import Path
from collections import Counter

# ---------- DEPS ----------
try:
    import onnx
    from onnx import version_converter, shape_inference
except ImportError:
    sys.exit("Install: pip install onnx")

try:
    import onnxruntime as ort
    HAS_ORT = True
except ImportError:
    HAS_ORT = False

try:
    from onnxsim import simplify
    HAS_SIMPLIFY = True
except ImportError:
    HAS_SIMPLIFY = False


PIPER_EXPECTED_INPUTS = {"input", "input_lengths", "scales", "sid"}
PIPER_EXPECTED_OUTPUTS = {"output"}
TARGET_OPSET = 15  # sweet spot per sherpa-onnx 1.12.26


def banner(msg, char="="):
    print(f"\n{char * 70}\n  {msg}\n{char * 70}")


def diagnose(model: onnx.ModelProto, label: str):
    banner(f"DIAGNOSI :: {label}")
    print(f"Producer:    '{model.producer_name}' v'{model.producer_version}'")
    print(f"IR version:  {model.ir_version}")
    print(f"Opset imports:")
    for op in model.opset_import:
        domain = op.domain or "ai.onnx"
        print(f"  domain='{domain}' version={op.version}")

    # metadata
    print(f"\nMetadata props ({len(model.metadata_props)}):")
    for p in model.metadata_props:
        v = p.value if len(p.value) < 80 else p.value[:77] + "..."
        print(f"  {p.key!r:25} = {v!r}")

    # inputs / outputs
    print(f"\nInputs ({len(model.graph.input)}):")
    for inp in model.graph.input:
        shape = [d.dim_value if d.dim_value else d.dim_param
                 for d in inp.type.tensor_type.shape.dim]
        dtype = inp.type.tensor_type.elem_type
        print(f"  {inp.name!r:25} dtype={dtype} shape={shape}")

    print(f"\nOutputs ({len(model.graph.output)}):")
    for out in model.graph.output:
        shape = [d.dim_value if d.dim_value else d.dim_param
                 for d in out.type.tensor_type.shape.dim]
        dtype = out.type.tensor_type.elem_type
        print(f"  {out.name!r:25} dtype={dtype} shape={shape}")

    # operator frequency
    op_count = Counter(node.op_type for node in model.graph.node)
    contrib = [n for n in model.graph.node if n.domain not in ("", "ai.onnx")]
    print(f"\nOp totali: {len(model.graph.node)}  unique: {len(op_count)}")
    print(f"Top 15 op:")
    for op, n in op_count.most_common(15):
        flag = "  ⚠️" if op in (
            "GroupNormalization", "LayerNormalization", "RotaryEmbedding",
            "Attention", "MultiHeadAttention", "SkipLayerNormalization",
        ) else ""
        print(f"  {op:35} x{n}{flag}")

    if contrib:
        print(f"\n⚠️  CONTRIB OPS rilevati ({len(contrib)}) — possibile problema sherpa mobile:")
        contrib_count = Counter(f"{n.domain}::{n.op_type}" for n in contrib)
        for op, n in contrib_count.most_common():
            print(f"  {op:50} x{n}")

    # input/output name compliance
    actual_in = {i.name for i in model.graph.input}
    actual_out = {o.name for o in model.graph.output}
    missing_in = PIPER_EXPECTED_INPUTS - actual_in - {"sid"}  # sid optional
    extra_in = actual_in - PIPER_EXPECTED_INPUTS
    missing_out = PIPER_EXPECTED_OUTPUTS - actual_out
    extra_out = actual_out - PIPER_EXPECTED_OUTPUTS

    print(f"\nPiper-compliance I/O:")
    if missing_in:
        print(f"  ❌ Inputs MANCANTI:    {missing_in}")
    if extra_in:
        print(f"  ⚠️  Inputs in più:      {extra_in}")
    if missing_out:
        print(f"  ❌ Outputs MANCANTI:   {missing_out}")
    if extra_out:
        print(f"  ⚠️  Outputs in più:     {extra_out}")
    if not (missing_in or missing_out):
        print(f"  ✅ Tutti i nomi standard sono presenti")

    return {
        "opset": [op.version for op in model.opset_import if (op.domain in ("", "ai.onnx"))][0],
        "op_count": dict(op_count),
        "contrib_ops": [f"{n.domain}::{n.op_type}" for n in contrib],
        "input_names": list(actual_in),
        "output_names": list(actual_out),
        "missing_inputs": list(missing_in),
        "missing_outputs": list(missing_out),
    }


def try_downgrade(model, target=TARGET_OPSET):
    banner(f"DOWNGRADE OPSET → {target}")
    current = [op.version for op in model.opset_import if (op.domain in ("", "ai.onnx"))][0]
    print(f"Current opset: {current} → target: {target}")
    if current <= target:
        print(f"  ✅ Già a opset {current}, nessun downgrade necessario.")
        return model

    try:
        converted = version_converter.convert_version(model, target)
        print(f"  ✅ Conversione opset {current} → {target} riuscita.")
        return converted
    except Exception as e:
        print(f"  ❌ Conversione fallita: {e}")
        print(f"  ⚠️  Provo con opset 13...")
        try:
            converted = version_converter.convert_version(model, 13)
            print(f"  ✅ Conversione opset {current} → 13 riuscita (fallback).")
            return converted
        except Exception as e2:
            print(f"  ❌ Anche opset 13 fallisce: {e2}")
            print(f"  ⚠️  Mantengo opset originale ({current}).")
            return model


def try_simplify(model):
    banner("ONNX-SIMPLIFIER (pulizia/ottimizzazione grafo)")
    if not HAS_SIMPLIFY:
        print("  ⚠️  onnx-simplifier non installato → skipping.")
        print("     Per installare: pip install onnxsim")
        return model
    try:
        simplified, ok = simplify(model)
        if ok:
            print("  ✅ Simplify riuscito.")
            print(f"  Op prima:  {len(model.graph.node)}")
            print(f"  Op dopo:   {len(simplified.graph.node)}")
            return simplified
        else:
            print("  ⚠️  Simplify ha completato ma con warning. Mantengo originale.")
            return model
    except Exception as e:
        print(f"  ❌ Simplify fallito: {e}")
        return model


def inject_piper_metadata(model, source_metadata):
    """Re-injecta i metadata Piper canonici dal modello sorgente."""
    banner("RE-INJECT METADATA PIPER (post-simplify)")
    # rimuovi metadata esistenti
    while len(model.metadata_props) > 0:
        del model.metadata_props[-1]
    # rimetti tutti i metadata originali
    for k, v in source_metadata.items():
        p = model.metadata_props.add()
        p.key = k
        p.value = v
    print(f"  ✅ Iniettati {len(source_metadata)} metadata props.")
    return model


def dry_run_load(path: str):
    banner("DRY-RUN CARICAMENTO con onnxruntime (simula sherpa)")
    if not HAS_ORT:
        print("  ⚠️  onnxruntime non installato → skipping.")
        print("     Per installare: pip install onnxruntime")
        return None
    try:
        opts = ort.SessionOptions()
        opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sess = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        print("  ✅ Modello caricato correttamente con onnxruntime!")
        print(f"  Sample inputs:")
        for i in sess.get_inputs():
            print(f"    {i.name!r}: shape={i.shape}, type={i.type}")
        print(f"  Sample outputs:")
        for o in sess.get_outputs():
            print(f"    {o.name!r}: shape={o.shape}, type={o.type}")
        return sess
    except Exception as e:
        print(f"  ❌ Caricamento fallito: {e}")
        print(f"  → Se fallisce qui, fallirà anche su Android.")
        return None


def main():
    if len(sys.argv) < 2:
        sys.exit("Uso: python remediate_piper_for_sherpa.py <beppe.onnx>")

    src = Path(sys.argv[1])
    if not src.exists():
        sys.exit(f"File non trovato: {src}")

    print(f"\n🔧 REMEDIATE PIPER FOR SHERPA-ONNX 1.12.26")
    print(f"   Source: {src.absolute()}")
    print(f"   Size:   {src.stat().st_size / 1024 / 1024:.2f} MB")

    # 1. Carica e diagnostica
    model = onnx.load(str(src))
    src_diag = diagnose(model, "BEPPE ORIGINALE (spoofato)")

    # Salva metadata source per re-inject post-simplify (simplify a volte li perde)
    source_metadata = {p.key: p.value for p in model.metadata_props}

    # 2. Downgrade opset
    model = try_downgrade(model, target=TARGET_OPSET)

    # 3. Re-injecta metadata (alcuni passaggi li perdono)
    model = inject_piper_metadata(model, source_metadata)

    # 4. Simplify
    model = try_simplify(model)
    # Simplify a volte rimuove metadata → re-iniettali ancora
    model = inject_piper_metadata(model, source_metadata)

    # 5. Diagnose finale
    final_diag = diagnose(model, "BEPPE COMPATIBLE (output)")

    # 6. Salva
    out_path = src.with_name(src.stem + "_compatible.onnx")
    onnx.save(model, str(out_path))
    print(f"\n💾 Salvato: {out_path}")
    print(f"   Size:   {out_path.stat().st_size / 1024 / 1024:.2f} MB")

    # 7. Dry-run con onnxruntime
    dry_run_load(str(out_path))

    # 8. Report finale
    banner("REPORT FINALE", char="*")
    print(f"  Opset:    {src_diag['opset']}  →  {final_diag['opset']}")
    print(f"  Op count: {sum(src_diag['op_count'].values())}  →  {sum(final_diag['op_count'].values())}")
    print(f"  Contrib:  {len(src_diag['contrib_ops'])}  →  {len(final_diag['contrib_ops'])}")
    print()
    print(f"  📦 Output file: {out_path}")
    print(f"  📋 Prossimi passi:")
    print(f"     1. Sostituisci  assets/piper/beppe.onnx  con  {out_path.name}")
    print(f"     2. cd /app/frontend && eas build --platform android --profile preview")
    print(f"     3. Testa l'APK sul dispositivo")
    print()


if __name__ == "__main__":
    main()
