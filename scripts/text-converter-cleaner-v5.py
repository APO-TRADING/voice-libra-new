import tkinter as tk
from tkinter import filedialog, messagebox, scrolledtext, ttk
import os
import re
import warnings
import pdfplumber
import PyPDF2
import docx
from ebooklib import epub
from bs4 import BeautifulSoup

class DocumentProcessor:
    def __init__(self):
        warnings.filterwarnings("ignore", category=UserWarning, module='bs4')

    def extract_text(self, file_path):
        if not os.path.exists(file_path):
            raise FileNotFoundError(f"File not found: {file_path}")
        ext = os.path.splitext(file_path)[1].lower()
        if ext == '.pdf':
            return self.extract_from_pdf(file_path)
        elif ext == '.epub':
            return self.extract_from_epub(file_path)
        elif ext == '.docx':
            return self.extract_from_docx(file_path)
        elif ext == '.txt':
            return self.extract_from_txt(file_path)
        else:
            raise ValueError(f"Unsupported file format: {ext}")

    def extract_from_pdf(self, file_path):
        text = ""
        try:
            with pdfplumber.open(file_path) as pdf:
                for page in pdf.pages:
                    text += (page.extract_text() or "") + "\n\n"
        except Exception:
            with open(file_path, 'rb') as f:
                reader = PyPDF2.PdfReader(f)
                for page in reader.pages:
                    text += (page.extract_text() or "") + "\n\n"
        return text.strip()

    def extract_from_epub(self, file_path):
        book = epub.read_epub(file_path)
        text = ""
        for item in book.get_items():
            if item.get_type() == 9:  # ITEM_DOCUMENT
                soup = BeautifulSoup(item.get_content(), 'html.parser')
                txt = soup.get_text(separator=' ')
                text += re.sub(r'\s+', ' ', txt).strip() + "\n\n"
        return text.strip()

    def extract_from_docx(self, file_path):
        doc = docx.Document(file_path)
        return "\n".join(p.text for p in doc.paragraphs if p.text.strip())

    def extract_from_txt(self, file_path):
        encodings = ['utf-8', 'latin-1', 'cp1252']
        for enc in encodings:
            try:
                with open(file_path, 'r', encoding=enc) as f:
                    return f.read()
            except UnicodeDecodeError:
                continue
        with open(file_path, 'rb') as f:
            return f.read().decode('utf-8', errors='replace')


class TextCleaner:
    def clean_text(self, text):
        text = re.sub(r'-\s*\n', '', text)
        text = re.sub(r'\s+', ' ', text)
        text = re.sub(r'\n{2,}', '\n\n', text)
        text = self._join_broken_lines(text)
        text = self._fix_punctuation(text)
        text = self._handle_special_chars(text)
        text = re.sub(r' +', ' ', text)
        text = re.sub(r'\n{3,}', '\n\n', text)
        
        # Aggiunta: separa le frasi con una riga vuota
        text = self.add_paragraph_after_sentences(text)
        
        return text.strip()

    def add_paragraph_after_sentences(self, text):
        # Prima puliamo eventuali spazi multipli o \n eccessivi
        text = re.sub(r'\n{3,}', '\n\n', text)
        
        # Dopo . ! ? (anche con virgolette di chiusura » ” ") + spazio + lettera maiuscola
        # → inseriamo \n\n prima della maiuscola
        text = re.sub(
            r'([.!?])([»”"]?)\s+([A-ZÀ-ÈÌÒÙ])',
            r'\1\2\n\n\3',
            text
        )
        
        # Gestione ellissi + maiuscola successiva
        text = re.sub(
            r'\.{3}([»”"]?)\s+([A-ZÀ-ÈÌÒÙ])',
            r'...\1\n\n\2',
            text
        )
        
        # Pulizia finale
        text = re.sub(r'\n{3,}', '\n\n', text)
        return text

    def _join_broken_lines(self, text):
        lines = text.splitlines()
        result = []
        i = 0
        while i < len(lines):
            line = lines[i].strip()
            if not line:
                result.append('')
                i += 1
                continue
            if i == len(lines) - 1 or re.search(r'[.!?:"»]$', line):
                result.append(line)
            else:
                next_line = lines[i + 1].strip()
                if next_line and (next_line[0].islower() or next_line[0] in ',:;)]}'):
                    result.append(f"{line} {next_line}")
                    i += 1
                else:
                    result.append(line)
            i += 1
        return '\n'.join(result)

    def _fix_punctuation(self, text):
        text = re.sub(r'\.([»”"])', r'\1.', text)
        text = re.sub(r'([.!?:;,])([^\s»""])(?!\d)', r'\1 \2', text)
        text = re.sub(r'(\s)([.!?:;,])', r'\2', text)
        text = re.sub(r'([«""])\s+', r'\1', text)
        text = re.sub(r'\s+([»""])', r'\1', text)
        text = re.sub(r'\.\s*\.\s*\.', '...', text)
        return text

    def _handle_special_chars(self, text):
        text = re.sub(r'[—–]', '-', text)
        text = re.sub(r'^[\s•\-*]+', '', text, flags=re.MULTILINE)
        text = re.sub(r'-{2,}', '-', text)
        return text

    def join_paragraphs(self, text, min_length=40):
        paragraphs = text.split('\n\n')
        result = []
        i = 0
        while i < len(paragraphs):
            current = paragraphs[i].strip()
            if not current:
                i += 1
                continue
            if len(current) < min_length and i < len(paragraphs) - 1:
                is_heading = current.endswith(':') or current.isupper()
                if not is_heading:
                    next_para = paragraphs[i + 1].strip()
                    if next_para:
                        result.append(f"{current} {next_para}")
                        i += 2
                        continue
            result.append(current)
            i += 1
        return '\n\n'.join(result)

    def remove_page_numbers(self, text):
        text = re.sub(r'^\s*\d+\s*$', '', text, flags=re.MULTILINE)
        text = re.sub(r'^\s*Page \d+ of \d+\s*$', '', text, flags=re.MULTILINE)
        text = re.sub(r'^\s*\d+\s*\|\s*Page\s*$', '', text, flags=re.MULTILINE)
        return re.sub(r'\n{3,}', '\n\n', text)


class TextCleanerApp(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Pulizia Testo da Documenti Multipli")
        self.geometry("900x600")
        self.processor = DocumentProcessor()
        self.cleaner = TextCleaner()
        self._build_ui()

    def _build_ui(self):
        frame = ttk.Frame(self)
        frame.pack(fill=tk.BOTH, expand=True, padx=10, pady=10)

        button_frame = ttk.Frame(frame)
        button_frame.pack(fill=tk.X)

        ttk.Button(button_frame, text="Carica Documenti", command=self.load_documents).pack(side=tk.LEFT, padx=5)

        self.text_area = scrolledtext.ScrolledText(frame, wrap=tk.WORD, font=("Segoe UI", 11))
        self.text_area.pack(fill=tk.BOTH, expand=True, pady=10)

    def load_documents(self):
        paths = filedialog.askopenfilenames(
            title="Seleziona uno o più documenti",
            filetypes=[("Documenti supportati", "*.pdf *.epub *.docx *.txt")]
        )
        if not paths:
            return

        self.text_area.delete(1.0, tk.END)
        success = []
        errors = []

        for path in paths:
            try:
                text = self.processor.extract_text(path)
                text = self.cleaner.clean_text(text)
                text = self.cleaner.join_paragraphs(text)
                text = self.cleaner.remove_page_numbers(text)

                dir_name = os.path.dirname(path)
                base_name = os.path.splitext(os.path.basename(path))[0]
                cleaned_path = os.path.join(dir_name, f"{base_name}-cleaned.txt")
                with open(cleaned_path, "w", encoding="utf-8") as f:
                    f.write(text.strip())

                success.append(os.path.basename(cleaned_path))
            except Exception as e:
                errors.append(f"{os.path.basename(path)}: {str(e)}")

        if success:
            self.text_area.insert(tk.END, f"Documenti puliti:\n" + "\n".join(success) + "\n\n")
        if errors:
            self.text_area.insert(tk.END, f"Errori:\n" + "\n".join(errors))

        messagebox.showinfo("Completato", f"Elaborazione completata.\n\n"
                                          f"Puliti: {len(success)} file\n"
                                          f"Con errori: {len(errors)} file")

if __name__ == "__main__":
    TextCleanerApp().mainloop()