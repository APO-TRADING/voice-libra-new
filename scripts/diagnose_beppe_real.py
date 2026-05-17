#!/usr/bin/env python3
"""
diagnose_beppe_real.py

Diagnosi PURA (no modifiche) del modello beppe.onnx ORIGINALE.
Identifica esattamente cosa fa crashare sherpa-onnx.

Uso:
  pip install onnx onnxruntime
  python diagnose_beppe_real.py beppe.onnx
"""

import sys
import json
from collections import Counter
import onnx


# Lista degli operatori "rari" che hanno kernel mancanti o problematici
# sulla build mobile di onnxruntime ARM64
PROBLEMATIC_OPS = {
    # Op contrib Microsoft (stripped su mobile)
    "Attention", "MultiHeadAttention", "SkipLayerNormalization",
    "EmbedLayerNormalization", "FastGelu", "Gelu", "BiasGelu",
    # Op con kernel ARM64 instabili
    "GroupNormalization", "RotaryEmbedding",
    # Op rari su mobile
    "DFT", "MelWeightMatrix", "STFT",
}

# Op che spesso causano problemi se mal-decomposti
WATCH_OPS = {
    "LayerNormalization", "BatchNormalization",
    "Conv", "ConvTranspose",
    "MatMul", "Gemm",
    "ScatterND", "GatherND", "Unique",
}


def main():
    if len(sys.argv) < 2:
        sys.exit("Uso: python diagnose_beppe_real.py <beppe.onnx>")

    path = sys.argv[1]
    print(f"\n{'='*70}")
    print(f"  DIAGNOSI PURA: {path}")
    print(f"{'='*70}\n")

    model = onnx.load(path)

    # 1) IDENTITÀ FILE
    print(f"📄 Producer:    '{model.producer_name}' v'{model.producer_version}'")
    print(f"📄 IR version:  {model.ir_version}")
    print(f"📄 Opset imports:")
    for op in model.opset_import:
        domain = op.domain or "ai.onnx"
        print(f"    domain='{domain}' version={op.version}")

    # 2) METADATA
    print(f"\n📋 Metadata props ({len(model.metadata_props)}):")
    for p in model.metadata_props:
        v = p.value if len(p.value) < 100 else p.value[:97] + "..."
        print(f"    {p.key!r:25} = {v!r}")

    # 3) INPUT/OUTPUT
    print(f"\n📥 Inputs ({len(model.graph.input)}):")
    for inp in model.graph.input:
        shape = [d.dim_value if d.dim_value else d.dim_param
                 for d in inp.type.tensor_type.shape.dim]
        print(f"    {inp.name!r:25} shape={shape}")
    print(f"\n📤 Outputs ({len(model.graph.output)}):")
    for out in model.graph.output:
        shape = [d.dim_value if d.dim_value else d.dim_param
                 for d in out.type.tensor_type.shape.dim]
        print(f"    {out.name!r:25} shape={shape}")

    # 4) OPERATORI: focus sui problematici
    print(f"\n🔍 Analisi operatori (totali: {len(model.graph.node)}):")

    op_count = Counter(n.op_type for n in model.graph.node)
    domain_count = Counter(n.domain for n in model.graph.node)

    print(f"\n  📊 Domini usati:")
    for d, n in domain_count.most_common():
        d_label = d if d else "ai.onnx (standard)"
        marker = "  ⚠️" if d not in ("", "ai.onnx") else ""
        print(f"    {d_label:35} x{n}{marker}")

    # 5) CONTRIB OPS — il vero killer probabile
    contrib_nodes = [n for n in model.graph.node if n.domain not in ("", "ai.onnx")]
    if contrib_nodes:
        print(f"\n  🚨 CONTRIB OPS RILEVATI ({len(contrib_nodes)}):")
        contrib_count = Counter(f"{n.domain}::{n.op_type}" for n in contrib_nodes)
        for op, n in contrib_count.most_common():
            print(f"    {op:50} x{n}")
        print(f"\n  ⚠️  Questi op possono essere STRIPPED dall'AAR Android")
        print(f"     di sherpa-onnx → cause probabile del SIGSEGV.")
    else:
        print(f"\n  ✅ Nessun op contrib non-standard (tutti in ai.onnx)")

    # 6) OPS PROBLEMATICI standard
    found_problematic = set(op_count.keys()) & PROBLEMATIC_OPS
    if found_problematic:
        print(f"\n  ⚠️  OPERATORI PROBLEMATICI rilevati:")
        for op in sorted(found_problematic):
            print(f"    {op:35} x{op_count[op]}")
    else:
        print(f"\n  ✅ Nessun operatore della lista 'problematici mobile'")

    # 7) TOP 20 operatori
    print(f"\n  📈 Top 20 operatori (frequenza):")
    for op, n in op_count.most_common(20):
        marker = "  ⚠️" if op in PROBLEMATIC_OPS else ""
        print(f"    {op:35} x{n}{marker}")

    # 8) TEST CARICAMENTO REALE con onnxruntime locale
    print(f"\n{'─'*70}")
    print(f"🧪 TEST CARICAMENTO con onnxruntime locale (simula sherpa)...")
    print(f"{'─'*70}")
    try:
        import onnxruntime as ort
        print(f"   onnxruntime version: {ort.__version__}")
        opts = ort.SessionOptions()
        opts.log_severity_level = 0  # verbose, mostra ogni dettaglio
        sess = ort.InferenceSession(path, opts, providers=["CPUExecutionProvider"])
        print(f"\n   ✅ MODELLO CARICATO con onnxruntime locale!")
        print(f"      → Se il PC carica e l'Android no, il problema è nell'AAR mobile")
        print(f"      → Soluzioni: upgrade sherpa-onnx, o rimuovere op contrib")

        # Stampa metadata letti
        meta_map = sess.get_modelmeta()
        print(f"\n   📋 Metadata letti da ORT:")
        print(f"      producer_name = {meta_map.producer_name!r}")
        print(f"      description   = {meta_map.description!r}")
        if meta_map.custom_metadata_map:
            for k, v in meta_map.custom_metadata_map.items():
                v_short = v if len(v) < 60 else v[:57] + "..."
                print(f"      {k:25} = {v_short!r}")

    except Exception as e:
        print(f"\n   ❌ MODELLO FALLISCE anche con onnxruntime locale!")
        print(f"      Errore: {e}")
        print(f"      → Bug strutturale nel modello, NON dipende da sherpa")
        print(f"      → Va corretto a livello di export Piper")

    print(f"\n{'='*70}\n")


if __name__ == "__main__":
    main()
