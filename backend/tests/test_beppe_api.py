"""Beppe Audiobooks backend API tests."""
import os
import io
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "https://tts-library-app.preview.emergentagent.com").rstrip("/")
API = f"{BASE_URL}/api"


@pytest.fixture(scope="session")
def s():
    return requests.Session()


# --- Health ---
def test_root_health(s):
    r = s.get(f"{API}/")
    assert r.status_code == 200
    j = r.json()
    assert j.get("app") == "Beppe Audiobooks"
    assert j.get("status") == "ok"
    assert "on-device" in (j.get("tts") or "").lower()


# --- TTS endpoints have been REMOVED (on-device TTS now) ---
def test_tts_status_removed(s):
    r = s.get(f"{API}/tts/status")
    assert r.status_code == 404


def test_tts_post_removed(s):
    r = s.post(f"{API}/tts", json={"text": "Ciao mondo", "length_scale": 1.0})
    assert r.status_code == 404


# --- Folders CRUD ---
class TestFolders:
    folder_id = None

    def test_create_folder(self, s):
        r = s.post(f"{API}/folders", json={"name": "TEST_Cartella1"})
        assert r.status_code == 200
        j = r.json()
        assert j["name"] == "TEST_Cartella1"
        assert "id" in j and "_id" not in j
        TestFolders.folder_id = j["id"]

    def test_list_folders(self, s):
        r = s.get(f"{API}/folders")
        assert r.status_code == 200
        arr = r.json()
        assert isinstance(arr, list)
        assert any(f["id"] == TestFolders.folder_id for f in arr)
        for f in arr:
            assert "_id" not in f

    def test_patch_folder(self, s):
        r = s.patch(f"{API}/folders/{TestFolders.folder_id}", json={"name": "TEST_CartellaRinominata"})
        assert r.status_code == 200
        assert r.json()["name"] == "TEST_CartellaRinominata"

    def test_delete_folder(self, s):
        r = s.delete(f"{API}/folders/{TestFolders.folder_id}")
        assert r.status_code == 200
        # verify gone
        r2 = s.patch(f"{API}/folders/{TestFolders.folder_id}", json={"name": "x"})
        assert r2.status_code == 404


# --- Book upload + CRUD + progress ---
class TestBooks:
    book_id = None
    sentence_count = 0

    def test_upload_txt(self, s):
        text = (
            "Questa e' una prova del libro Beppe. La voce italiana legge le frasi. "
            "Il testo viene pulito e diviso in frasi. Buona lettura a tutti! "
            "Il sistema deve contare correttamente le parole e le frasi."
        )
        files = {"file": ("TEST_book.txt", io.BytesIO(text.encode("utf-8")), "text/plain")}
        data = {"title": "TEST_Libro Beppe"}
        r = s.post(f"{API}/books/upload", files=files, data=data)
        assert r.status_code == 200, r.text
        j = r.json()
        assert j["title"] == "TEST_Libro Beppe"
        assert j["sentence_count"] > 0
        assert j["word_count"] > 0
        assert "_id" not in j
        TestBooks.book_id = j["id"]
        TestBooks.sentence_count = j["sentence_count"]

    def test_list_books_contains(self, s):
        r = s.get(f"{API}/books")
        assert r.status_code == 200
        arr = r.json()
        ids = [b["id"] for b in arr]
        assert TestBooks.book_id in ids
        for b in arr:
            assert "_id" not in b

    def test_get_book_full(self, s):
        r = s.get(f"{API}/books/{TestBooks.book_id}")
        assert r.status_code == 200
        j = r.json()
        assert "sentences" in j and isinstance(j["sentences"], list)
        assert len(j["sentences"]) == TestBooks.sentence_count
        assert "_id" not in j

    def test_patch_book_title_and_length_clamp(self, s):
        r = s.patch(f"{API}/books/{TestBooks.book_id}", json={"title": "TEST_Nuovo", "length_scale": 5.0})
        assert r.status_code == 200
        j = r.json()
        assert j["title"] == "TEST_Nuovo"
        assert j["length_scale"] == 2.0  # clamped upper

        r2 = s.patch(f"{API}/books/{TestBooks.book_id}", json={"length_scale": 0.1})
        assert r2.json()["length_scale"] == 0.5  # clamped lower

    def test_progress_clamps(self, s):
        # over upper bound
        r = s.patch(f"{API}/books/{TestBooks.book_id}/progress", json={"current_sentence_index": 9999})
        assert r.status_code == 200
        assert r.json()["current_sentence_index"] == TestBooks.sentence_count - 1
        # negative
        r2 = s.patch(f"{API}/books/{TestBooks.book_id}/progress", json={"current_sentence_index": -10})
        assert r2.json()["current_sentence_index"] == 0
        # valid
        r3 = s.patch(f"{API}/books/{TestBooks.book_id}/progress", json={"current_sentence_index": 1})
        assert r3.json()["current_sentence_index"] == 1

    def test_delete_book(self, s):
        r = s.delete(f"{API}/books/{TestBooks.book_id}")
        assert r.status_code == 200
        r2 = s.get(f"{API}/books/{TestBooks.book_id}")
        assert r2.status_code == 404
