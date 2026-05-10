# Beppe Audiobooks - PRD

## App
Mobile-first Expo (React Native) audiobook reader powered by Piper TTS.

## Stack
- Backend: FastAPI + MongoDB (motor), text extraction (pdfplumber/PyPDF2/python-docx/ebooklib/BeautifulSoup), Piper TTS (lazy-loaded if model present)
- Frontend: Expo Router with tabs (Libreria, Cartelle, Carica, Impostazioni) + Player route. expo-speech for device-side TTS fallback. AsyncStorage for theme/view prefs.

## Core flows
1. Upload eBook (PDF/EPUB/DOCX/TXT) → text cleaning (port of user script) → sentence splitting → MongoDB.
2. Library grid/list view with theme toggle and progress bars.
3. Folders: create/rename/delete; books move between folders.
4. Player: per-sentence playback (singleton, stops previous on new request), highlight active sentence, skip ±1/±5/±10, length_scale slider 0.5×–2.0×, time-remaining estimate, debounced progress save.
5. Persist current_sentence_index so book resumes from interrupted sentence.
6. Settings: dark/light, view mode, default speed, TTS engine status.

## TTS Strategy
- Backend `/api/tts/status` reports availability of `assets/piper/beppe.onnx`. If absent, frontend uses `expo-speech` (Italian voice) as fallback.
- When user adds beppe.onnx + installs `piper-tts`, backend serves WAV base64 from `/api/tts`.

## Endpoints
- GET/POST /api/folders, PATCH/DELETE /api/folders/{id}
- GET /api/books?folder_id=, GET /api/books/{id}, POST /api/books/upload (multipart), PATCH /api/books/{id}, DELETE, PATCH /api/books/{id}/progress
- GET /api/tts/status, POST /api/tts

## Persistence
All library state in MongoDB; user preferences (theme, view mode, default length_scale) in AsyncStorage.
