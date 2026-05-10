"""
Beppe Audiobooks backend.
"""
import logging
import os
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from motor.motor_asyncio import AsyncIOMotorClient
from pydantic import BaseModel, Field

from text_cleaner import DocumentProcessor, TextCleaner, split_sentences, count_words


ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

mongo_url = os.environ["MONGO_URL"]
client = AsyncIOMotorClient(mongo_url)
db = client[os.environ["DB_NAME"]]

app = FastAPI(title="Beppe Audiobooks API")
api = APIRouter(prefix="/api")

logging.basicConfig(level=logging.INFO,
                    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s")
logger = logging.getLogger("beppe")

processor = DocumentProcessor()
cleaner = TextCleaner()


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Folder(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    created_at: str = Field(default_factory=now_iso)


class FolderCreate(BaseModel):
    name: str


class FolderUpdate(BaseModel):
    name: str


class Book(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    title: str
    cover_url: Optional[str] = None
    folder_id: Optional[str] = None
    word_count: int = 0
    sentence_count: int = 0
    current_sentence_index: int = 0
    length_scale: float = 1.0
    created_at: str = Field(default_factory=now_iso)
    updated_at: str = Field(default_factory=now_iso)


class BookSummary(BaseModel):
    id: str
    title: str
    cover_url: Optional[str] = None
    folder_id: Optional[str] = None
    word_count: int
    sentence_count: int
    current_sentence_index: int
    length_scale: float
    created_at: str
    updated_at: str


class BookUpdate(BaseModel):
    title: Optional[str] = None
    cover_url: Optional[str] = None
    folder_id: Optional[str] = None
    length_scale: Optional[float] = None


class ProgressUpdate(BaseModel):
    current_sentence_index: int


def book_summary(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "title": doc["title"],
        "cover_url": doc.get("cover_url"),
        "folder_id": doc.get("folder_id"),
        "word_count": doc.get("word_count", 0),
        "sentence_count": doc.get("sentence_count", 0),
        "current_sentence_index": doc.get("current_sentence_index", 0),
        "length_scale": doc.get("length_scale", 1.0),
        "created_at": doc.get("created_at"),
        "updated_at": doc.get("updated_at"),
    }


@api.get("/")
async def root():
    return {"app": "Beppe Audiobooks", "status": "ok", "tts": "on-device (Piper via sherpa-onnx)"}


@api.get("/folders", response_model=List[Folder])
async def list_folders():
    docs = await db.folders.find({}, {"_id": 0}).sort("name", 1).to_list(1000)
    return [Folder(**d) for d in docs]


@api.post("/folders", response_model=Folder)
async def create_folder(payload: FolderCreate):
    folder = Folder(name=payload.name.strip())
    if not folder.name:
        raise HTTPException(400, "Nome cartella obbligatorio")
    await db.folders.insert_one(folder.model_dump())
    return folder


@api.patch("/folders/{folder_id}", response_model=Folder)
async def update_folder(folder_id: str, payload: FolderUpdate):
    name = payload.name.strip()
    if not name:
        raise HTTPException(400, "Nome cartella obbligatorio")
    res = await db.folders.find_one_and_update(
        {"id": folder_id},
        {"$set": {"name": name}},
        return_document=True,
        projection={"_id": 0},
    )
    if not res:
        raise HTTPException(404, "Cartella non trovata")
    return Folder(**res)


@api.delete("/folders/{folder_id}")
async def delete_folder(folder_id: str):
    res = await db.folders.delete_one({"id": folder_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Cartella non trovata")
    await db.books.update_many({"folder_id": folder_id}, {"$set": {"folder_id": None}})
    return {"ok": True}


@api.get("/books", response_model=List[BookSummary])
async def list_books(folder_id: Optional[str] = None):
    query: dict = {}
    if folder_id is not None:
        query["folder_id"] = folder_id if folder_id != "none" else None
    docs = await db.books.find(query, {"_id": 0, "content": 0, "sentences": 0}).sort("updated_at", -1).to_list(2000)
    return [BookSummary(**book_summary(d)) for d in docs]


@api.get("/books/{book_id}")
async def get_book(book_id: str):
    doc = await db.books.find_one({"id": book_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Libro non trovato")
    return doc


@api.post("/books/upload")
async def upload_book(
    file: UploadFile = File(...),
    title: Optional[str] = Form(None),
    cover_url: Optional[str] = Form(None),
    folder_id: Optional[str] = Form(None),
):
    raw = await file.read()
    try:
        text = processor.extract(file.filename, raw)
    except ValueError as e:
        raise HTTPException(400, str(e))
    except Exception as e:
        logger.exception("Estrazione fallita")
        raise HTTPException(500, f"Estrazione fallita: {e}")

    cleaned = cleaner.clean(text)
    sentences = split_sentences(cleaned)
    if not sentences:
        raise HTTPException(400, "Documento vuoto dopo la pulizia")

    fallback_title = os.path.splitext(file.filename or "")[0] or "Senza titolo"
    final_title = (title.strip() if title else fallback_title) or "Senza titolo"

    book = Book(
        title=final_title,
        cover_url=cover_url or None,
        folder_id=folder_id or None,
        word_count=count_words(cleaned),
        sentence_count=len(sentences),
    )
    doc = book.model_dump()
    doc["content"] = cleaned
    doc["sentences"] = sentences
    await db.books.insert_one(doc)
    return book_summary(doc)


@api.patch("/books/{book_id}", response_model=BookSummary)
async def update_book(book_id: str, payload: BookUpdate):
    update: dict = {"updated_at": now_iso()}
    if payload.title is not None:
        t = payload.title.strip()
        if not t:
            raise HTTPException(400, "Titolo non valido")
        update["title"] = t
    if payload.cover_url is not None:
        update["cover_url"] = payload.cover_url or None
    if payload.folder_id is not None:
        update["folder_id"] = payload.folder_id or None
    if payload.length_scale is not None:
        update["length_scale"] = max(0.5, min(2.0, float(payload.length_scale)))

    res = await db.books.find_one_and_update(
        {"id": book_id},
        {"$set": update},
        return_document=True,
        projection={"_id": 0, "content": 0, "sentences": 0},
    )
    if not res:
        raise HTTPException(404, "Libro non trovato")
    return BookSummary(**book_summary(res))


@api.patch("/books/{book_id}/progress", response_model=BookSummary)
async def update_progress(book_id: str, payload: ProgressUpdate):
    doc = await db.books.find_one({"id": book_id}, {"_id": 0, "sentence_count": 1})
    if not doc:
        raise HTTPException(404, "Libro non trovato")
    idx = max(0, min(payload.current_sentence_index, max(0, doc.get("sentence_count", 1) - 1)))
    res = await db.books.find_one_and_update(
        {"id": book_id},
        {"$set": {"current_sentence_index": idx, "updated_at": now_iso()}},
        return_document=True,
        projection={"_id": 0, "content": 0, "sentences": 0},
    )
    return BookSummary(**book_summary(res))


@api.delete("/books/{book_id}")
async def delete_book(book_id: str):
    res = await db.books.delete_one({"id": book_id})
    if res.deleted_count == 0:
        raise HTTPException(404, "Libro non trovato")
    return {"ok": True}


app.include_router(api)
app.add_middleware(
    CORSMiddleware,
    allow_credentials=True,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.on_event("shutdown")
async def shutdown():
    client.close()
