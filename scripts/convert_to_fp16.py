#!/usr/bin/env python3
"""
CONVERTITORE FP16 AVANZATO PER PIPER/VITS
-------------------------------------------------
Sviluppato per gestire nodi sensibili e mismatch di precisione nei modelli Piper.
Mantiene compatibilità I/O con Sherpa-ONNX.

Strategia: auto-healing iterativo
=================================
1) Blocca proattivamente le zone Piper note per rompersi in fp16
   (/dp, /flow, /enc_p, /enc_q + ops sensibili Add/Mul/Clip/Range).
2) Tenta la conversione + smoke test in onnxruntime CPU.
3) Se il caricamento fallisce, parsa il messaggio d'errore di onnxruntime
   per estrarre il nome del nodo problematico, lo aggiunge alla blacklist
   insieme ai suoi predecessori (depth 3) e ritenta.
4) Ripete fino a max_attempts (150) o finché il modello carica.
5) Solo allora salva su un file .tmp e fa atomic replace sull'originale.

Utilizzo
========
    pip install onnx onnxconverter-common onnxruntime
    python scripts/convert_to_fp16.py frontend/assets/piper/beppe.onnx

Il file di input viene sovrascritto IN-PLACE solo dopo validazione completa.
Se qualcosa fallisce, l'originale resta intatto.
"""

from __future__ import annotations
import os
import sys
import re
from pathlib import Path


def fmt_mb(n_bytes: int) -> str:
    return f"{n_bytes / 1024 / 1024:.1f}MB"


def main() -> int:
    if len(sys.argv) < 2 or sys.argv[1] in ("-h", "--help"):
        print("Utilizzo: python convert_to_fp16.py modello.onnx")
        return 1

    src = Path(sys.argv[1]).resolve()
    if not src.exists():
        print(f"ERROR: file non trovato: {src}", file=sys.stderr)
        return 1

    try:
        import onnx
        import onnxruntime as ort
        from onnxconverter_common import float16
    except ImportError:
        print("ERROR: Installare le dipendenze: pip install onnx onnxconverter-common onnxruntime")
        return 1

    src_size = src.stat().st_size
    print(f"==> Caricamento modello: {src.name} ({fmt_mb(src_size)})")
    try:
        model = onnx.load(str(src))
    except Exception as e:
        print(f"ERROR: Caricamento fallito: {e}")
        return 2

    # Preservazione metadati per Sherpa-ONNX
    orig_metadata = list(model.metadata_props)
    orig_producer = model.producer_name
    orig_producer_version = model.producer_version
    orig_ir_version = model.ir_version

    # --- LOGICA DI AUTO-RIPARAZIONE ---
    print("\n==> Avvio Deep Scan (Auto-Healing dei nodi sensibili)")

    # Mappatura del grafo
    node_lookup = {n.name: n for n in model.graph.node if n.name}
    input_to_node = {t: n.name for n in model.graph.node for t in n.output}

    def get_predecessors(node_name, depth=3):
        preds = set()
        if node_name not in node_lookup or depth <= 0:
            return preds
        node = node_lookup[node_name]
        for inp in node.input:
            if inp in input_to_node:
                parent = input_to_node[inp]
                preds.add(parent)
                preds.update(get_predecessors(parent, depth - 1))
        return preds

    # Configurazione protezione iniziale
    nodes_to_block = set(['input', 'output'])
    # Zone critiche che tipicamente rompono Piper in FP16
    critical_zones = ['/dp', '/flow', '/enc_p', '/enc_q', 'Add', 'Mul', 'Clip', 'Range']
    for n_name in node_lookup:
        if any(x in n_name for x in critical_zones):
            nodes_to_block.add(n_name)

    final_fp16_model = None
    max_attempts = 150

    for attempt in range(1, max_attempts + 1):
        sys.stdout.write(f"\r[Tentativo {attempt}/{max_attempts}] Nodi protetti: {len(nodes_to_block)}")
        sys.stdout.flush()

        try:
            # Carichiamo ogni volta il modello pulito per evitare accumulo di modifiche
            current_clean_model = onnx.load(str(src))

            tmp_model = float16.convert_float_to_float16(
                current_clean_model,
                keep_io_types=True,
                node_block_list=list(nodes_to_block),
                min_positive_val=1e-7,
                max_finite_val=1e4,
                disable_shape_infer=True
            )

            # Smoke test: se carica in ONNX Runtime, è stabile
            ort.InferenceSession(tmp_model.SerializeToString(), providers=['CPUExecutionProvider'])

            # Se arriviamo qui senza eccezioni, il modello è valido
            final_fp16_model = tmp_model
            print(f"\n✅ Modello stabilizzato con successo al tentativo {attempt}!")
            break

        except Exception as e:
            err = str(e)
            # Estraggono il nome del nodo che ha causato il mismatch di tipo
            found = re.findall(r'node \((.*?)\)', err)
            if found:
                failed_node = found[0]
                nodes_to_block.add(failed_node)
                # Proteggiamo anche i genitori per evitare discrepanze a monte
                nodes_to_block.update(get_predecessors(failed_node))
            else:
                # In caso di errore generico, forziamo in FP32 i nodi di gestione forma
                for n in model.graph.node:
                    if n.op_type in ['Cast', 'Reshape', 'Resize', 'Unsqueeze']:
                        nodes_to_block.add(n.name)

        if attempt == max_attempts:
            print(f"\n❌ Errore: Superato il limite di {max_attempts} tentativi.")
            return 3

    # --- RIPRISTINO METADATI E SALVATAGGIO ---
    if final_fp16_model:
        final_fp16_model.producer_name = orig_producer or "pytorch"
        final_fp16_model.producer_version = orig_producer_version or ""
        final_fp16_model.ir_version = orig_ir_version
        del final_fp16_model.metadata_props[:]
        for prop in orig_metadata:
            new_prop = final_fp16_model.metadata_props.add()
            new_prop.key = prop.key
            new_prop.value = prop.value

        tmp_file = src.with_suffix(src.suffix + ".tmp")
        print(f"==> Salvataggio in corso...")
        onnx.save(final_fp16_model, str(tmp_file))

        # Validazione finale del file su disco
        try:
            onnx.checker.check_model(str(tmp_file))
            os.replace(str(tmp_file), str(src))

            new_size = src.stat().st_size
            reduction = (1 - new_size / src_size) * 100
            print("-" * 40)
            print(f"SUCCESSO: {src.name} è ora in FP16.")
            print(f"Dimensione: {fmt_mb(src_size)} -> {fmt_mb(new_size)} (-{reduction:.1f}%)")
            print("-" * 40)
        except Exception as e:
            print(f"❌ Errore durante la validazione finale: {e}")
            if tmp_file.exists():
                tmp_file.unlink()
            return 4

    return 0


if __name__ == "__main__":
    sys.exit(main())
