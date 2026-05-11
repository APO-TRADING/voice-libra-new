#!/usr/bin/env python3
"""
prepare_piper_model.py
======================

Prepara un modello Piper (.onnx + .onnx.json) per essere usato con
sherpa-onnx dentro l'app Beppe Audiobooks.

Fa due cose:
  1) Aggiunge i metadata interni richiesti da sherpa-onnx al file .onnx
     (model_type=vits, comment=piper, language, voice, has_espeak, ...).
  2) Genera tokens.txt dal phoneme_id_map nel .onnx.json.

Dopo l'esecuzione, sherpa-onnx leggerà direttamente .onnx + tokens.txt e
NON avrà più bisogno del file .json originale.

USO
---
    # 1) Installa dipendenze (una sola volta)
    pip install onnx==1.17.0

    # 2) Metti il tuo modello qui:
    #      frontend/assets/piper/beppe.onnx
    #      frontend/assets/piper/beppe.onnx.json

    # 3) Lancia lo script dalla radice del repo:
    python scripts/prepare_piper_model.py

    # 4) Adesso frontend/assets/piper/ contiene:
    #      beppe.onnx         (con metadata aggiunti, in-place)
    #      tokens.txt         (auto-generato)
    #      espeak-ng-data.bin (già presente)
    #
    #    Il file beppe.onnx.json puoi cancellarlo o lasciarlo: non viene
    #    più usato dall'app.

Lo script è derivato dall'esempio ufficiale sherpa-onnx:
https://k2-fsa.github.io/sherpa/onnx/tts/piper.html#add-meta-data-to-the-onnx-model
"""
import json
import sys
from pathlib import Path
from typing import Any, Dict

try:
    import onnx
except ImportError:
    sys.stderr.write("ERRORE: pacchetto 'onnx' non installato. Esegui: pip install onnx==1.17.0\n")
    sys.exit(1)


ASSETS_DIR = Path(__file__).resolve().parent.parent / "frontend" / "assets" / "piper"
MODEL_PATH = ASSETS_DIR / "beppe.onnx"
CONFIG_PATH = ASSETS_DIR / "beppe.onnx.json"
TOKENS_PATH = ASSETS_DIR / "tokens.txt"


def add_meta_data(filename: Path, meta_data: Dict[str, Any]) -> None:
    """Aggiunge metadata a un modello ONNX (in-place).
    Rimuove sempre i metadata esistenti prima di scrivere quelli nuovi,
    così lo script è idempotente (lo puoi rilanciare senza duplicare)."""
    model = onnx.load(str(filename))
    del model.metadata_props[:]
    for key, value in meta_data.items():
        meta = model.metadata_props.add()
        meta.key = key
        meta.value = str(value)
    onnx.save(model, str(filename))


def generate_tokens(config: dict, out_path: Path) -> int:
    """Genera tokens.txt dal phoneme_id_map; ritorna numero di token."""
    id_map = config["phoneme_id_map"]
    with out_path.open("w", encoding="utf-8") as f:
        for sym, ids in id_map.items():
            if isinstance(ids, list) and ids:
                f.write(f"{sym} {ids[0]}\n")
    return len(id_map)


def main() -> int:
    if not MODEL_PATH.exists():
        sys.stderr.write(f"ERRORE: non trovo {MODEL_PATH}\n")
        return 1
    if not CONFIG_PATH.exists():
        sys.stderr.write(f"ERRORE: non trovo {CONFIG_PATH}\n")
        return 1

    print(f"-> Leggo config da {CONFIG_PATH.name}")
    with CONFIG_PATH.open("r", encoding="utf-8") as f:
        config = json.load(f)

    print(f"-> Genero {TOKENS_PATH.name}")
    n = generate_tokens(config, TOKENS_PATH)
    print(f"   {n} token scritti")

    meta_data = {
        "model_type": "vits",
        "comment": "piper",
        "language": config.get("language", {}).get("name_english", "Italian"),
        "voice": config.get("espeak", {}).get("voice", "it"),
        "has_espeak": 1,
        "n_speakers": config.get("num_speakers", 1),
        "sample_rate": config.get("audio", {}).get("sample_rate", 22050),
    }
    print(f"-> Aggiungo metadata a {MODEL_PATH.name}:")
    for k, v in meta_data.items():
        print(f"     {k} = {v}")
    add_meta_data(MODEL_PATH, meta_data)

    # Genera anche un piper-config.json che l'app legge a runtime per
    # configurare l'AudioTrack col sample rate REALE del modello. Senza
    # questo, AudioTrack userebbe il default hardcoded del wrapper (22050 Hz)
    # e la voce uscirebbe alterata se il modello è 16000 Hz (Piper "low").
    runtime_cfg_path = ASSETS_DIR / "piper-config.json"
    runtime_cfg = {
        "sample_rate": int(meta_data["sample_rate"]),
        "language": meta_data["language"],
        "voice": meta_data["voice"],
        "n_speakers": int(meta_data["n_speakers"]),
    }
    runtime_cfg_path.write_text(
        json.dumps(runtime_cfg, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"-> Scritto {runtime_cfg_path.name}: {runtime_cfg}")

    print()
    print("✓ Fatto! Adesso puoi buildare l'APK:")
    print("    cd frontend && npx expo prebuild --clean && eas build --platform android --profile preview --clear-cache")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
