// Italian translations (default)
// Keep keys flat / dot-namespaced. Always add new keys here FIRST then mirror
// in en/es/de/fr — the t() helper falls back to italian if a key is missing
// in a translation file.
export const it = {
  // Generic
  'common.cancel': 'Annulla',
  'common.save': 'Salva',
  'common.delete': 'Elimina',
  'common.edit': 'Modifica',
  'common.play': 'Riproduci',
  'common.pause': 'Pausa',
  'common.ok': 'OK',
  'common.confirm': 'Conferma',
  'common.error': 'Errore',
  'common.search': 'Cerca',
  'common.close': 'Chiudi',
  'common.back': 'Indietro',
  'common.loading': 'Caricamento…',
  'common.optional': 'opzionale',

  // Tabs
  'tabs.library': 'Libreria',
  'tabs.folders': 'Cartelle',
  'tabs.upload': 'Carica',
  'tabs.settings': 'Impostazioni',

  // Library
  'library.title': 'Libreria',
  'library.empty.title': 'La tua libreria è vuota',
  'library.empty.body': 'Carica un eBook (PDF, EPUB, DOCX o TXT) per iniziare ad ascoltare.',
  'library.empty.cta': 'Carica un libro',
  'library.search.placeholder': 'Cerca per titolo o autore…',
  'library.empty.search': 'Nessun libro corrisponde alla ricerca.',
  'library.empty.generic': 'Nessun libro nella libreria.',
  'library.nowPlaying': 'IN ASCOLTO',
  'library.paused': 'IN PAUSA',
  'library.bookCount.one': '{n} libro',
  'library.bookCount.other': '{n} libri',
  'library.bookCount.zero': '0 libri',
  'library.sort.recent': 'Recenti',
  'library.sort.title': 'Titolo',
  'library.sort.author': 'Autore',
  'library.sort.manual': 'Manuale',
  'library.book.delete.confirmTitle': 'Elimina libro',
  'library.book.delete.confirmBody': 'Eliminare "{title}"? Questa azione non può essere annullata.',
  'library.book.progress': '{percent}% • {count} frasi',
  'library.book.wordCount': '{percent}% • {count} parole',

  // Folders
  'folders.title': 'Cartelle',
  'folders.new': 'Nuova',
  'folders.unfiled': 'Senza cartella',
  'folders.folderCount.one': '{n} libro',
  'folders.folderCount.other': '{n} libri',
  'folders.empty': 'Nessuna cartella. Toccare "Nuova" per crearne una.',
  'folders.create': 'Nuova cartella',
  'folders.rename': 'Rinomina cartella',
  'folders.name.placeholder': 'Nome cartella',
  'folders.create.cta': 'Crea',
  'folders.delete.confirmTitle': 'Elimina cartella',
  'folders.delete.confirmBody': 'Eliminare "{name}"? I libri non verranno cancellati.',
  'folders.eyebrow': 'CARTELLA',
  'folders.empty.inside': 'Nessun libro in "{name}". Aprire un libro dalla libreria e usare "Modifica" per assegnarlo a questa cartella.',
  'folders.empty.unfiled': 'Nessun libro senza cartella.',

  // Upload
  'upload.title': 'Carica',
  'upload.subtitle': 'PDF, EPUB, DOCX o TXT — estrazione e pulizia tutto offline sul dispositivo.',
  'upload.pick.placeholder': 'Tocca per selezionare un file',
  'upload.pick.hint': '.pdf .epub .docx .txt (offline)',
  'upload.field.title': 'TITOLO',
  'upload.field.title.placeholder': 'Titolo del libro',
  'upload.field.author': 'AUTORE',
  'upload.field.author.placeholder': 'Nome autore (opzionale, utile per filtrare)',
  'upload.field.cover': 'COPERTINA',
  'upload.field.cover.gallery': 'Da galleria',
  'upload.field.cover.url': '…oppure URL immagine',
  'upload.field.folder': 'CARTELLA (FACOLTATIVO)',
  'upload.field.folder.none': 'Nessuna',
  'upload.submit': 'Carica nella libreria',
  'upload.missing': 'Seleziona un eBook (PDF, EPUB, DOCX o TXT).',
  'upload.missing.title': 'File mancante',
  'upload.done.title': 'Caricato',
  'upload.done.body': '"{title}" aggiunto alla libreria.',
  'upload.gallery.denied': 'Concedi accesso alla galleria per scegliere una copertina.',
  'upload.gallery.deniedTitle': 'Permesso negato',

  // Book edit
  'bookEdit.title': 'Modifica libro',
  'bookEdit.field.title': 'TITOLO',
  'bookEdit.field.author': 'AUTORE',
  'bookEdit.field.author.placeholder': 'Nome autore (opzionale)',
  'bookEdit.field.cover': 'COPERTINA',
  'bookEdit.field.folder': 'CARTELLA',
  'bookEdit.titleRequired': 'Inserisci almeno un titolo.',
  'bookEdit.titleRequired.title': 'Titolo obbligatorio',
  'bookEdit.saving': 'Salvataggio…',

  // Player (already in code, only key strings reused via t())
  'player.play': 'Riproduci',
  'player.pause': 'Pausa',
  'player.duration': 'Durata',
  'player.speed': 'Velocità',
  'player.sentence': 'Frase',
  'player.of': 'di',

  // Settings
  'settings.title': 'Impostazioni',
  'settings.section.appearance': 'Aspetto',
  'settings.section.playback': 'Riproduzione',
  'settings.section.language': 'Lingua',
  'settings.section.about': 'Informazioni',
  'settings.theme.label': 'Tema',
  'settings.theme.system': 'Sistema',
  'settings.theme.light': 'Chiaro',
  'settings.theme.dark': 'Scuro',
  'settings.viewMode.label': 'Vista predefinita',
  'settings.viewMode.grid': 'Griglia',
  'settings.viewMode.list': 'Lista',
  'settings.language.label': 'Lingua dell\'app',
  'settings.language.system': 'Lingua del sistema',

  // Voice import
  'voice.import.button': 'Importa voce…',
  'voice.import.hint': 'Carica un file .zip che contiene model.onnx e model.onnx.json, oppure seleziona entrambi i file insieme dal picker.',
  'voice.import.inProgress': 'Importazione…',
  'voice.import.success.title': 'Voce importata',
  'voice.import.success.body': '"{name}" è ora disponibile nella lista.',
  'voice.import.failed.title': 'Importazione fallita',
  'voice.import.delete.confirmTitle': 'Elimina voce',
  'voice.import.delete.confirmBody': 'Eliminare la voce "{name}"? Il file occupa {size} MB sul dispositivo.',
  'voice.import.delete.button': 'Elimina',
  'voice.import.dynamic.badge': 'PERSONALE',

  // Errors
  'error.bookNotFound': 'Libro non trovato',
  'error.contentMissing': 'Contenuto libro mancante',
  'error.empty': 'Documento vuoto dopo la pulizia',
};

export type TranslationKey = keyof typeof it;
export type TranslationDict = Record<TranslationKey, string>;
