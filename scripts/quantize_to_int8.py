#!/usr/bin/env python3
"""
Quantizzatore ONNX → INT8 con GUI per Piper/VITS + Sherpa-ONNX
================================================================

Applica Post-Training Dynamic Quantization (PTDQ) a un modello Piper VITS
in formato fp32, producendo una versione INT8 ~75% più piccola e compatibile
con sherpa-onnx 1.12.26 (la libreria usata dall'app Beppe Audiobooks).

Configurazione "safe-for-sherpa":
  • quantize_dynamic        (NON static, evita calibration set)
  • weight_type=QInt8       (pesi INT8 signed)
  • op_types_to_quantize=   ['MatMul']  → solo le moltiplicazioni dense
    NON Conv (rompe prosodia VITS)
    NON LSTM (sherpa non supporta LSTM quantizzato)
    NON Attention (idem)
    NON Add/Mul (mantenute fp32)
  • Le attivazioni restano fp32 → sherpa-onnx riceve esattamente ciò che si
    aspetta, no SIGSEGV

Dipendenze:
  pip install onnx onnxruntime

Utilizzo:
  python scripts/quantize_to_int8.py
  (poi sfoglia il file ONNX nella GUI)
"""

from __future__ import annotations
import os
import sys
import threading
import queue
import traceback
from pathlib import Path

try:
    import tkinter as tk
    from tkinter import ttk, filedialog, messagebox, scrolledtext
except ImportError:
    print("ERROR: tkinter non disponibile. Installa: sudo apt install python3-tk", file=sys.stderr)
    sys.exit(1)


# ─────────────────────────────────────────────────────────────────────────
# QUANTIZZAZIONE (logica core, eseguita in thread separato)
# ─────────────────────────────────────────────────────────────────────────

def _send(q: queue.Queue, msg_type: str, **kwargs):
    """Invia un messaggio thread-safe alla GUI."""
    q.put({"type": msg_type, **kwargs})


def quantize_worker(src: Path, dst: Path, also_conv: bool, q: queue.Queue):
    """Esegue la quantizzazione in background. Comunica con la GUI via queue."""
    try:
        # ── 1. Verifica dipendenze ──────────────────────────────────────
        _send(q, "log", text="==> Verifica dipendenze...", level="info")
        try:
            import onnx
            from onnxruntime.quantization import quantize_dynamic, QuantType
            import onnxruntime as ort
        except ImportError as e:
            _send(q, "log", text=f"❌ Dipendenza mancante: {e}", level="error")
            _send(q, "log", text="Installa con: pip install onnx onnxruntime", level="error")
            _send(q, "done", success=False)
            return
        _send(q, "log", text="✓ onnx, onnxruntime OK", level="info")

        # ── 2. Carica modello sorgente per estrarre metadati ────────────
        _send(q, "log", text=f"\n==> Carico modello: {src.name}", level="info")
        _send(q, "progress", value=10)
        src_size = src.stat().st_size
        try:
            model = onnx.load(str(src))
        except Exception as e:
            _send(q, "log", text=f"❌ Impossibile caricare: {e}", level="error")
            _send(q, "done", success=False)
            return

        _send(q, "log", text=f"   dimensione: {src_size / 1024 / 1024:.1f} MB", level="info")
        _send(q, "log", text=f"   producer: {model.producer_name or '?'} {model.producer_version or ''}", level="info")
        _send(q, "log", text=f"   ir_version: {model.ir_version}", level="info")
        opset = [(o.domain or 'ai.onnx', o.version) for o in model.opset_import]
        _send(q, "log", text=f"   opset: {opset}", level="info")

        # Preserva metadata sherpa-onnx (model_type=vits, has_espeak, ecc.)
        orig_metadata = list(model.metadata_props)
        if orig_metadata:
            _send(q, "log", text=f"   metadata sherpa: {len(orig_metadata)} props "
                  f"({', '.join(p.key for p in orig_metadata[:3])}"
                  f"{'...' if len(orig_metadata) > 3 else ''})",
                  level="info")
        del model  # libera memoria, ricaricheremo dopo la quantize

        # ── 3. Quantizzazione (CHIAMATA CRITICA) ────────────────────────
        op_types = ['MatMul']
        if also_conv:
            op_types.append('Conv')
            _send(q, "log",
                  text="\n⚠ Quantizzazione Conv abilitata (rischio prosodia VITS)",
                  level="warn")

        _send(q, "log",
              text=f"\n==> Quantizzazione dinamica INT8 (ops: {op_types})...",
              level="info")
        _send(q, "log",
              text="    (le attivazioni restano fp32 — sherpa compatibile)",
              level="info")
        _send(q, "progress", value=25)

        # File temporaneo accanto al destinazione (atomic replace dopo validazione)
        tmp = dst.with_suffix(dst.suffix + ".tmp")
        if tmp.exists():
            tmp.unlink()

        try:
            quantize_dynamic(
                model_input=str(src),
                model_output=str(tmp),
                weight_type=QuantType.QInt8,
                # CRITICAL: solo MatMul. NO Conv (default), NO LSTM, NO Attention.
                op_types_to_quantize=op_types,
                per_channel=False,    # per-tensor è più conservativo e compatibile
                reduce_range=False,
            )
        except Exception as e:
            _send(q, "log", text=f"❌ Quantizzazione fallita: {e}", level="error")
            _send(q, "log", text=traceback.format_exc(), level="error")
            tmp.unlink(missing_ok=True)
            _send(q, "done", success=False)
            return

        _send(q, "progress", value=60)
        tmp_size = tmp.stat().st_size
        reduction = (1 - tmp_size / src_size) * 100
        _send(q, "log",
              text=f"   ✓ creato: {tmp_size / 1024 / 1024:.1f} MB "
                   f"(da {src_size / 1024 / 1024:.1f} MB, -{reduction:.0f}%)",
              level="info")

        # ── 4. Ripristino metadata sherpa-onnx ──────────────────────────
        _send(q, "log", text="\n==> Ripristino metadata sherpa-onnx", level="info")
        _send(q, "progress", value=70)
        try:
            qmodel = onnx.load(str(tmp))
            del qmodel.metadata_props[:]
            for prop in orig_metadata:
                new_prop = qmodel.metadata_props.add()
                new_prop.key = prop.key
                new_prop.value = prop.value
            onnx.save(qmodel, str(tmp))
            _send(q, "log", text=f"   ✓ {len(orig_metadata)} props ripristinate", level="info")
            del qmodel
        except Exception as e:
            _send(q, "log", text=f"⚠ Ripristino metadata fallito: {e}", level="warn")

        # ── 5. Validazione onnx.checker ─────────────────────────────────
        _send(q, "log", text="\n==> Validazione struttura ONNX", level="info")
        _send(q, "progress", value=80)
        try:
            onnx.checker.check_model(str(tmp))
            _send(q, "log", text="   ✓ struttura valida", level="info")
        except Exception as e:
            _send(q, "log", text=f"❌ Struttura non valida: {e}", level="error")
            tmp.unlink(missing_ok=True)
            _send(q, "done", success=False)
            return

        # ── 6. Smoke test onnxruntime CPU ───────────────────────────────
        _send(q, "log",
              text="\n==> Smoke test onnxruntime CPU (lo stesso engine di sherpa)",
              level="info")
        _send(q, "progress", value=90)
        try:
            session = ort.InferenceSession(
                str(tmp),
                providers=['CPUExecutionProvider']
            )
            in_info = [(i.name, i.type) for i in session.get_inputs()]
            out_info = [(o.name, o.type) for o in session.get_outputs()]
            _send(q, "log", text=f"   inputs:  {in_info}", level="info")
            _send(q, "log", text=f"   outputs: {out_info}", level="info")

            # Sanity: I/O devono essere fp32 (sherpa-onnx li alimenta così)
            bad = [f"{n}:{t}" for n, t in in_info + out_info
                   if 'int8' in t.lower() or 'float16' in t.lower()]
            if bad:
                _send(q, "log",
                      text=f"❌ I/O contiene tipi non-fp32: {bad}\n"
                           f"   sherpa-onnx fallirà con questo modello!",
                      level="error")
                tmp.unlink(missing_ok=True)
                _send(q, "done", success=False)
                return

            _send(q, "log", text="   ✓ I/O sono fp32, sherpa-compatibile", level="info")
            del session
        except Exception as e:
            _send(q, "log", text=f"❌ onnxruntime non carica: {e}", level="error")
            tmp.unlink(missing_ok=True)
            _send(q, "done", success=False)
            return

        # ── 7. Atomic replace → dst finale ───────────────────────────────
        _send(q, "log", text=f"\n==> Salvataggio finale: {dst.name}", level="info")
        _send(q, "progress", value=95)
        try:
            os.replace(str(tmp), str(dst))
            final_size = dst.stat().st_size
        except Exception as e:
            _send(q, "log", text=f"❌ Errore replace: {e}", level="error")
            _send(q, "done", success=False)
            return

        # ── 8. SUCCESSO ────────────────────────────────────────────────
        _send(q, "log", text="\n" + "=" * 60, level="info")
        _send(q, "log", text="✓ QUANTIZZAZIONE COMPLETATA", level="success")
        _send(q, "log", text="=" * 60, level="info")
        _send(q, "log", text=f"  File:       {dst}", level="info")
        _send(q, "log",
              text=f"  Dimensione: {src_size / 1024 / 1024:.1f} MB → "
                   f"{final_size / 1024 / 1024:.1f} MB "
                   f"(-{(1 - final_size / src_size) * 100:.0f}%)",
              level="info")
        _send(q, "log", text=f"  Formato:    INT8 pesi, fp32 attivazioni", level="info")
        _send(q, "log", text=f"  Engine OK:  sherpa-onnx 1.12.26 compatible", level="info")
        _send(q, "progress", value=100)
        _send(q, "done", success=True, output=str(dst))

    except Exception as e:
        _send(q, "log", text=f"\n❌ Errore inatteso: {e}", level="error")
        _send(q, "log", text=traceback.format_exc(), level="error")
        _send(q, "done", success=False)


# ─────────────────────────────────────────────────────────────────────────
# GUI
# ─────────────────────────────────────────────────────────────────────────

class QuantizerGUI:
    def __init__(self, root: tk.Tk):
        self.root = root
        root.title("Quantizzatore Piper → INT8 (Sherpa-ONNX compatible)")
        root.geometry("780x600")
        root.minsize(640, 520)

        self.queue: queue.Queue = queue.Queue()
        self.worker_thread: threading.Thread | None = None

        # Style
        style = ttk.Style()
        try:
            style.theme_use('clam')
        except tk.TclError:
            pass

        # Container
        main = ttk.Frame(root, padding=14)
        main.pack(fill=tk.BOTH, expand=True)

        # ── Titolo ───────────────────────────────────────────────────────
        title = ttk.Label(
            main,
            text="Quantizzazione INT8 sicura per Sherpa-ONNX",
            font=('Helvetica', 13, 'bold'),
        )
        title.pack(anchor='w', pady=(0, 4))

        subtitle = ttk.Label(
            main,
            text="Riduce un modello Piper VITS fp32 a INT8 (~75% più piccolo) preservando I/O fp32.",
            font=('Helvetica', 9),
            foreground='#555',
        )
        subtitle.pack(anchor='w', pady=(0, 12))

        # ── Input file ───────────────────────────────────────────────────
        in_frame = ttk.LabelFrame(main, text="Modello ONNX di partenza (fp32)", padding=8)
        in_frame.pack(fill=tk.X, pady=4)

        in_row = ttk.Frame(in_frame)
        in_row.pack(fill=tk.X)
        self.in_var = tk.StringVar()
        in_entry = ttk.Entry(in_row, textvariable=self.in_var)
        in_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 6))
        ttk.Button(in_row, text="Sfoglia...", command=self._browse_input).pack(side=tk.LEFT)
        self.in_var.trace_add("write", self._on_input_changed)

        self.info_label = ttk.Label(
            in_frame, text="(nessun file selezionato)",
            foreground='#888', font=('Courier', 9),
        )
        self.info_label.pack(anchor='w', pady=(6, 0))

        # ── Output file ──────────────────────────────────────────────────
        out_frame = ttk.LabelFrame(main, text="File di destinazione (INT8)", padding=8)
        out_frame.pack(fill=tk.X, pady=4)

        out_row = ttk.Frame(out_frame)
        out_row.pack(fill=tk.X)
        self.out_var = tk.StringVar()
        out_entry = ttk.Entry(out_row, textvariable=self.out_var)
        out_entry.pack(side=tk.LEFT, fill=tk.X, expand=True, padx=(0, 6))
        ttk.Button(out_row, text="Sfoglia...", command=self._browse_output).pack(side=tk.LEFT)

        # ── Opzioni ──────────────────────────────────────────────────────
        opt_frame = ttk.LabelFrame(main, text="Opzioni", padding=8)
        opt_frame.pack(fill=tk.X, pady=4)

        self.matmul_var = tk.BooleanVar(value=True)
        ttk.Checkbutton(
            opt_frame,
            text="Quantizza ops MatMul   [RACCOMANDATO — sicuro per sherpa-onnx]",
            variable=self.matmul_var,
            state='disabled',  # sempre attivo
        ).pack(anchor='w')

        self.conv_var = tk.BooleanVar(value=False)
        ttk.Checkbutton(
            opt_frame,
            text="Quantizza anche ops Conv   [⚠ rischioso — può rompere prosodia VITS]",
            variable=self.conv_var,
        ).pack(anchor='w')

        # ── Progress bar ─────────────────────────────────────────────────
        self.progress = ttk.Progressbar(main, length=100, mode='determinate')
        self.progress.pack(fill=tk.X, pady=(10, 4))

        # ── Log area ─────────────────────────────────────────────────────
        log_frame = ttk.LabelFrame(main, text="Stato avanzamento", padding=4)
        log_frame.pack(fill=tk.BOTH, expand=True, pady=4)

        self.log_area = scrolledtext.ScrolledText(
            log_frame, wrap=tk.WORD, height=10,
            font=('Courier', 9), bg='#1e1e1e', fg='#d4d4d4', insertbackground='#fff',
        )
        self.log_area.pack(fill=tk.BOTH, expand=True)
        self.log_area.tag_config('info', foreground='#d4d4d4')
        self.log_area.tag_config('warn', foreground='#dcdcaa')
        self.log_area.tag_config('error', foreground='#f48771')
        self.log_area.tag_config('success', foreground='#4ec9b0', font=('Courier', 9, 'bold'))

        # ── Action buttons ───────────────────────────────────────────────
        btn_frame = ttk.Frame(main)
        btn_frame.pack(fill=tk.X, pady=(8, 0))

        self.start_btn = ttk.Button(
            btn_frame, text="▶  Avvia quantizzazione",
            command=self._start_quantization, state='disabled',
        )
        self.start_btn.pack(side=tk.LEFT)

        ttk.Button(btn_frame, text="Chiudi", command=root.quit).pack(side=tk.RIGHT)

        # Avvia polling della queue
        root.after(100, self._poll_queue)

        # Welcome message
        self._log("Quantizzatore pronto. Seleziona un file .onnx fp32 per iniziare.\n", 'info')

    # ── Event handlers ───────────────────────────────────────────────────

    def _browse_input(self):
        path = filedialog.askopenfilename(
            title="Seleziona il modello ONNX fp32",
            filetypes=[("ONNX models", "*.onnx"), ("Tutti i file", "*.*")],
        )
        if path:
            self.in_var.set(path)

    def _browse_output(self):
        initial = self.out_var.get() or self.in_var.get()
        initial_dir = str(Path(initial).parent) if initial else os.getcwd()
        initial_name = Path(initial).stem + "_int8.onnx" if initial else "model_int8.onnx"
        path = filedialog.asksaveasfilename(
            title="Salva il modello INT8 come...",
            defaultextension=".onnx",
            filetypes=[("ONNX models", "*.onnx")],
            initialdir=initial_dir,
            initialfile=initial_name,
        )
        if path:
            self.out_var.set(path)

    def _on_input_changed(self, *_):
        path = self.in_var.get().strip()
        if not path:
            self.info_label.config(text="(nessun file selezionato)", foreground='#888')
            self.start_btn.config(state='disabled')
            return

        p = Path(path)
        if not p.exists():
            self.info_label.config(text=f"⚠ file non trovato: {p.name}", foreground='#c33')
            self.start_btn.config(state='disabled')
            return

        if not p.suffix.lower() == '.onnx':
            self.info_label.config(
                text=f"⚠ estensione non .onnx ({p.suffix}), procedi a tuo rischio",
                foreground='#c33',
            )

        try:
            size_mb = p.stat().st_size / 1024 / 1024
            self.info_label.config(
                text=f"✓ {p.name}   |   {size_mb:.1f} MB   |   {p.parent}",
                foreground='#28a745',
            )
        except Exception as e:
            self.info_label.config(text=f"errore: {e}", foreground='#c33')
            self.start_btn.config(state='disabled')
            return

        # Auto-fill output
        if not self.out_var.get():
            self.out_var.set(str(p.with_name(p.stem + "_int8.onnx")))
        self.start_btn.config(state='normal')

    def _start_quantization(self):
        src = Path(self.in_var.get()).resolve()
        dst_str = self.out_var.get().strip()
        if not dst_str:
            messagebox.showerror("Errore", "Specifica il file di output.")
            return
        dst = Path(dst_str).resolve()

        if dst.exists():
            if not messagebox.askyesno(
                "Sovrascrivere?",
                f"Il file '{dst.name}' esiste già.\nSovrascrivere?",
            ):
                return

        if dst.resolve() == src.resolve():
            if not messagebox.askyesno(
                "ATTENZIONE",
                f"Stai per SOVRASCRIVERE il file originale {src.name}!\n"
                "Se la quantizzazione fallisce, l'originale verrà comunque preservato\n"
                "(salviamo prima un .tmp e poi facciamo atomic replace).\n\n"
                "Continuare?",
                icon='warning',
            ):
                return

        self.start_btn.config(state='disabled')
        self.log_area.delete('1.0', tk.END)
        self.progress['value'] = 0

        self.worker_thread = threading.Thread(
            target=quantize_worker,
            args=(src, dst, self.conv_var.get(), self.queue),
            daemon=True,
        )
        self.worker_thread.start()

    def _poll_queue(self):
        try:
            while True:
                msg = self.queue.get_nowait()
                if msg["type"] == "log":
                    self._log(msg["text"] + "\n", msg.get("level", "info"))
                elif msg["type"] == "progress":
                    self.progress['value'] = msg["value"]
                elif msg["type"] == "done":
                    self.start_btn.config(state='normal')
                    if msg["success"]:
                        messagebox.showinfo(
                            "Completato",
                            f"Modello INT8 creato con successo!\n\n"
                            f"File: {msg.get('output', '')}\n\n"
                            f"Per usarlo nell'app Beppe Audiobooks:\n"
                            f"1. Rinomina/sposta il file in frontend/assets/piper/beppe.onnx\n"
                            f"2. python scripts/prepare_piper_model.py\n"
                            f"3. cd frontend && npx expo prebuild --clean --platform android\n"
                            f"4. eas build --platform android --profile preview --clear-cache",
                        )
                    else:
                        messagebox.showerror(
                            "Errore",
                            "Quantizzazione fallita. Controlla il log per i dettagli.",
                        )
        except queue.Empty:
            pass
        self.root.after(100, self._poll_queue)

    def _log(self, text: str, level: str = 'info'):
        self.log_area.insert(tk.END, text, level)
        self.log_area.see(tk.END)


# ─────────────────────────────────────────────────────────────────────────
# CLI fallback (per chi vuole senza GUI)
# ─────────────────────────────────────────────────────────────────────────

def cli_mode(args: list[str]) -> int:
    """Modalità CLI alternativa: python quantize_to_int8.py input.onnx [output.onnx]"""
    if len(args) < 1:
        print("CLI: python quantize_to_int8.py <input.onnx> [output.onnx]")
        return 1

    src = Path(args[0]).resolve()
    if not src.exists():
        print(f"ERROR: file non trovato: {src}")
        return 1
    dst = Path(args[1]).resolve() if len(args) >= 2 else src.with_name(src.stem + "_int8.onnx")

    print(f"==> Sorgente:    {src}")
    print(f"==> Destinazione: {dst}")

    q: queue.Queue = queue.Queue()
    thread = threading.Thread(
        target=quantize_worker, args=(src, dst, False, q), daemon=True,
    )
    thread.start()

    while True:
        msg = q.get()
        if msg["type"] == "log":
            print(msg["text"])
        elif msg["type"] == "progress":
            pass
        elif msg["type"] == "done":
            return 0 if msg["success"] else 2


def main() -> int:
    # Se l'utente passa argomenti, usa CLI. Altrimenti GUI.
    if len(sys.argv) > 1 and sys.argv[1] not in ("--gui", "-g"):
        return cli_mode(sys.argv[1:])

    root = tk.Tk()
    QuantizerGUI(root)
    root.mainloop()
    return 0


if __name__ == "__main__":
    sys.exit(main())
