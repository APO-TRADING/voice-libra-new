#!/usr/bin/env python3
"""
remediate_piper_v2.py

Pipeline CORRETTA per portare un modello Piper 2.x a opset 14
compatibile con sherpa-onnx 1.12.26 (AAR Android).

DIFFERENZA con lo script precedente:
- usa onnx.version_converter (vero downgrade del grafo)
- NON usa quant_pre_process (che NON fa downgrade)
- NON imposta manualmente opset_import[0].version (cosmetico/pericoloso)

Uso:
  pip install onnx onnxruntime
  python remediate_piper_v2.py
"""

import os
import sys
import json
import onnx
from onnx import version_converter, shape_inference


def main():
    path_beppe_orig = "beppe.onnx"          # ORIGINALE da Piper 2.10
    path_beppe_json = "beppe.onnx.json"     # Config Piper
    cartella_out = "./output_pronto"
    path_output = os.path.join(cartella_out, "beppe.onnx")

    if not (os.path.exists(path_beppe_orig) and os.path.exists(path_beppe_json)):
        print("[-] Servono: beppe.onnx + beppe.onnx.json")
        sys.exit(1)

    print("=" * 70)
    print(" PIPELINE v2: VERO DOWNGRADE OPSET via version_converter ")
    print("=" * 70)

    # -------------------------------------------------------------------------
    # FASE 1: Caricamento + diagnosi opset originale
    # -------------------------------------------------------------------------
    print("\n[*] Fase 1: Carico modello originale e analizzo opset...")
    model = onnx.load(path_beppe_orig)
    original_opset = next(
        (op.version for op in model.opset_import if op.domain in ("", "ai.onnx")),
        None,
    )
    contrib_ops = [n for n in model.graph.node if n.domain not in ("", "ai.onnx")]
    print(f"    Opset originale: {original_opset}")
    print(f"    Contrib ops:     {len(contrib_ops)}")
    print(f"    Nodi totali:     {len(model.graph.node)}")

    if contrib_ops:
        print(f"    ⚠️  WARNING: trovati op contrib non standard:")
        for n in contrib_ops[:5]:
            print(f"       - {n.domain}::{n.op_type}")
        print(f"       version_converter NON li converte. Vedi note finali.")

    # -------------------------------------------------------------------------
    # FASE 2: Shape inference (importante PRIMA del version_converter)
    # -------------------------------------------------------------------------
    print("\n[*] Fase 2: Shape inference sul grafo originale...")
    try:
        model = shape_inference.infer_shapes(model)
        print(f"    ✅ Shape inference completata")
    except Exception as e:
        print(f"    ⚠️  Shape inference parzialmente fallita: {e}")
        print(f"    (Procedo comunque)")

    # -------------------------------------------------------------------------
    # FASE 3: VERO DOWNGRADE OPSET tramite version_converter
    # -------------------------------------------------------------------------
    print("\n[*] Fase 3: Downgrade VERO del grafo a opset 14...")
    target_opset = 14
    try:
        model = version_converter.convert_version(model, target_opset)
        new_opset = next(
            (op.version for op in model.opset_import if op.domain in ("", "ai.onnx")),
            None,
        )
        print(f"    ✅ Downgrade riuscito: opset {original_opset} → {new_opset}")
    except Exception as e:
        print(f"    ❌ Downgrade opset 14 fallito: {e}")
        print(f"    ⚠️  Provo opset 15 (fallback)...")
        try:
            model = onnx.load(path_beppe_orig)  # ripartiamo dall'originale
            model = version_converter.convert_version(model, 15)
            print(f"    ✅ Downgrade riuscito a opset 15 (fallback)")
        except Exception as e2:
            print(f"    ❌ Anche opset 15 fallisce: {e2}")
            print(f"    ⚠️  Mantengo opset originale {original_opset}")
            print(f"    Possibile causa: il modello usa op contrib non convertibili.")
            print(f"    SUGGERIMENTO: re-esporta il modello da Piper con")
            print(f"                  opset_version=14 nello script di export.")

    # -------------------------------------------------------------------------
    # FASE 4: Iniezione metadati Piper canonici (ASCII-safe)
    # -------------------------------------------------------------------------
    print("\n[*] Fase 4: Iniezione metadati Piper canonici...")
    with open(path_beppe_json, "r", encoding="utf-8") as f:
        config_data = json.load(f)
    config_json_safe = json.dumps(config_data, ensure_ascii=True)

    sample_rate = str(config_data.get("audio", {}).get("sample_rate", "16000"))
    num_speakers = str(config_data.get("num_speakers", "1"))
    voice = str(config_data.get("espeak", {}).get("voice", "it"))

    chiavi_target = {
        "sample_rate": sample_rate,
        "num_speakers": num_speakers,
        "n_speakers": num_speakers,
        "voice": voice,
        "language": "it",
        "model_type": "vits",
        "comment": "piper",        # ← USA "piper" che è il valore CANONICO!
        "has_espeak": "1",
        "piper_text_vits_config": config_json_safe,
    }

    # Svuota i vecchi metadata (version_converter a volte li perde)
    while len(model.metadata_props) > 0:
        model.metadata_props.pop()
    for k, v in chiavi_target.items():
        meta = model.metadata_props.add()
        meta.key = k
        meta.value = str(v)

    # NB: NON cambiamo opset_import manualmente (lo ha già fatto version_converter)
    # NB: spoofing del producer_name lo lasciamo opzionale (cosmetico)
    model.producer_name = "pytorch"
    model.producer_version = "1.13.1"
    model.ir_version = 8

    # -------------------------------------------------------------------------
    # FASE 5: Salvataggio
    # -------------------------------------------------------------------------
    os.makedirs(cartella_out, exist_ok=True)
    onnx.save(model, path_output)
    size_mb = os.path.getsize(path_output) / 1024 / 1024

    # -------------------------------------------------------------------------
    # FASE 6: Verifica finale con onnxruntime (simula caricamento sherpa)
    # -------------------------------------------------------------------------
    print("\n[*] Fase 6: Dry-run con onnxruntime locale...")
    try:
        import onnxruntime as ort
        sess = ort.InferenceSession(path_output, providers=["CPUExecutionProvider"])
        print(f"    ✅ Modello caricato OK con onnxruntime")
        print(f"    Inputs:  {[(i.name, i.shape, i.type) for i in sess.get_inputs()]}")
        print(f"    Outputs: {[(o.name, o.shape, o.type) for o in sess.get_outputs()]}")
    except Exception as e:
        print(f"    ❌ Caricamento fallito: {e}")
        print(f"    Se fallisce qui, fallirà anche su Android.")

    # -------------------------------------------------------------------------
    print("\n" + "=" * 70)
    print(f"[+++] FATTO!")
    print(f"      Output: {path_output}")
    print(f"      Dim:    {size_mb:.2f} MB")
    print("=" * 70)


if __name__ == "__main__":
    main()
