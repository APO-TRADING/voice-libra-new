// scripts/test-foreignWords-sentences.mjs
//
// End-to-end smoke test for v1.0.4 wrapForeignWords() on realistic
// thriller sentences. Validates BOTH:
//   - which tokens get wrapped (mock phonemizer returns "IPA[token]")
//   - which Italian words DON'T get wrapped (false-positive check)
//
// The native phonemizer is mocked: we don't need the real one here
// since we're testing the JS classifier and the SSML wrap shape.

// ─── Inline copy of the v1.0.4 production rules (keep in lock-step!) ───
const ITALIAN_WHITELIST = new Set([
  'sport','fitness','wellness','beauty','spa','jogging','footing',
  'trekking','surf','snowboard','hotel','motel','bar','pub','club',
  'lounge','resort','check','cocktail','drink','happy','menu',
  'computer','internet','online','offline','email','web','file',
  'link','mouse','click','chat','video','audio','media','social',
  'app','login','logout','password','server','router','gadget',
  'device','tablet','smartphone','film','movie','show','thriller',
  'fashion','design','designer','style','trend','leader','manager',
  'staff','team','marketing','business','meeting','partner',
  'weekend','party','event','live','flash','breaking','sandwich',
  'toast','snack','brunch','fast','food','hamburger','pizza',
  'jeans','shorts','tshirt','t-shirt','pullover','shock','stress',
  'relax','cool','super','top','okay','taxi','bus','tram',
  'parking','garage','box','standard','optional','special','extra',
  'master','banner','logo','slogan','spot',
]);
const URBAN_KEYWORDS = new Set([
  'avenue','street','boulevard','drive','highway','road',
  'broadway','plaza','square','lane','court','place',
  'sheriff','deputy','detective','agent',
]);
const PROPER_NAMES_EN = new Set([
  'manhattan','sunset','hollywood','harlem','bronx','queens',
  'vegas','seattle','boston','denver','houston','austin',
  'dallas','miami','atlanta','memphis','detroit','portland',
  'pittsburgh','baltimore','philly','newark','staten',
  'westwood','beverly','malibu','venice','pasadena',
  'compton','oakland','berkeley','sacramento',
  'london','thames','soho','camden','chelsea',
  'donovan','sullivan','callahan','flanagan','morgan',
  'reagan','sloan','logan','cohen','allen',
  'jordan','nolan','lawson','jackson','wilson',
  'johnson','jefferson','anderson','robinson','thompson',
  'harrison','peterson','davidson','henderson',
  'kevin','gavin','devin','colin','martin','justin',
  'austin','kenneth','harold','gerald','donald',
  'ronald','arnold','sheldon',
]);
const RE_ENGLISH_CLUSTERS = [
  /ck/i, /sh/i, /sch/i, /th/i, /ph/i, /wh/i,
  /ch(?![eiy])/i,
  /gh(?![ei])/i,
  /^kn/i, /^ps/i,
  /ee/i, /oo/i,
  /ay(?:$|[^aeiouy])/i,
  /ow(?:$|[^aeiouy])/i,
];
const RE_FINAL_CLUSTERS = [
  /[aeiou](?:nd|rg|rk|rt|ck|lk|ng|st|sk)$/i,
  /[^aeiou]y$/i,
];
const RE_PATRONYMIC = /^(?:Mc|Mac)[A-Z]/;

function tokenIsLoanword(token) {
  if (token.length < 3) return false;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    if (!(isUpper || isLower)) return false;
  }
  const lower = token.toLowerCase();
  if (ITALIAN_WHITELIST.has(lower)) return false;
  if (URBAN_KEYWORDS.has(lower)) return true;
  if (PROPER_NAMES_EN.has(lower)) return true;
  if (RE_PATRONYMIC.test(token)) return true;
  for (const re of RE_ENGLISH_CLUSTERS) if (re.test(token)) return true;
  for (const re of RE_FINAL_CLUSTERS) if (re.test(token)) return true;
  return false;
}

function escapeXmlText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function escapeXmlAttribute(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function wrapForeignWords(text, mockPhonemize) {
  const re = /[\p{L}']+|[^\p{L}']+/gu;
  const matches = [];
  const uniqueLoanwords = new Set();
  let m;
  while ((m = re.exec(text)) !== null) {
    const chunk = m[0];
    if (!/^[\p{L}']+$/u.test(chunk)) continue;
    if (!tokenIsLoanword(chunk)) continue;
    matches.push({ start: m.index, end: m.index + chunk.length, token: chunk });
    uniqueLoanwords.add(chunk);
  }
  if (matches.length === 0) return text;

  const ipaMap = new Map();
  for (const tok of uniqueLoanwords) {
    const ipa = await mockPhonemize(tok, 'en-us');
    ipaMap.set(tok, ipa);
  }

  let out = '';
  let cursor = 0;
  for (const { start, end, token } of matches) {
    if (start > cursor) out += escapeXmlText(text.slice(cursor, start));
    const ipa = ipaMap.get(token) || '';
    if (ipa) {
      out += `<phoneme alphabet="espeak" ph="${escapeXmlAttribute(ipa)}">${escapeXmlText(token)}</phoneme>`;
    } else {
      out += escapeXmlText(token);
    }
    cursor = end;
  }
  if (cursor < text.length) out += escapeXmlText(text.slice(cursor));
  return out;
}

// ─── Test sentences (thriller-style, in Italian) ──────────────────────
const tests = [
  {
    desc: 'Glock + verbo italiano',
    text: 'Lui impugnò la Glock e sparò.',
    mustWrap:   ['Glock'],
    mustNotWrap:['impugnò', 'sparò'],  // accented → ASCII guard rejects
  },
  {
    desc: 'Personaggio Connelly + ambientazione US',
    text: 'Harry Bosch, il detective di Los Angeles, parlò con Michael Connelly.',
    mustWrap:   ['Harry', 'Bosch', 'detective', 'Michael', 'Connelly'],
    mustNotWrap:['di', 'Los', 'Angeles', 'parlò'],  // Los/Angeles 3-letter / capitalised
                                                    // — Los is 3 chars ok ASCII no cluster: PASS
                                                    // Angeles: contains "ge" "ang" "eles" no cluster:
                                                    //   `el` no, `es$` no in final list. OK.
  },
  {
    desc: 'Indirizzo americano (Broadway, Sunset Boulevard)',
    text: 'Camminò lungo Sunset Boulevard fino a Broadway.',
    mustWrap:   ['Sunset', 'Boulevard', 'Broadway'],
    mustNotWrap:['lungo', 'fino'],
  },
  {
    desc: 'Acronimi US (LAPD, FBI) — non match (3-char, tutti maiuscoli)',
    text: 'La LAPD chiamò l\'FBI immediatamente.',
    mustWrap:   [],
    mustNotWrap:['LAPD', 'FBI', 'chiamò', 'immediatamente'],
  },
  {
    desc: 'Italianismi (sport, hotel) NON intercettati',
    text: 'Ha prenotato un hotel e poi fa sport tutti i weekend.',
    mustWrap:   [],
    mustNotWrap:['hotel', 'sport', 'weekend'],
  },
  {
    desc: 'McCaleb + Charlie + Knight (test patronimici e gh/ch)',
    text: 'L\'agente McCaleb arrivò con Charlie e Knight.',
    mustWrap:   ['McCaleb', 'Charlie', 'Knight'],
    mustNotWrap:['con', 'arrivò'],   // "agente" è italiano (NON in PROPER_NAMES_EN)
  },
  {
    desc: 'Frase Italiana pura (nessun wrap)',
    text: 'Si girò lentamente verso la finestra e guardò fuori.',
    mustWrap:   [],
    mustNotWrap:['girò', 'lentamente', 'verso', 'finestra', 'guardò', 'fuori'],
  },
  {
    desc: 'Manhattan + Vegas + Hollywood (toponimi US dalla lista)',
    text: 'Da Manhattan a Las Vegas, passando per Hollywood.',
    mustWrap:   ['Manhattan', 'Vegas', 'Hollywood'],
    mustNotWrap:['passando'],
  },
  {
    desc: 'Frase con homograph italiano "voltò" (regex non deve catturare)',
    text: 'Si voltò verso il muro e guardò la fotografia.',
    mustWrap:   [],
    mustNotWrap:['voltò', 'guardò', 'fotografia'],  // tutte accentate/italiane
  },
  {
    desc: 'Glock + sparo (test apostrofo)',
    text: 'L\'arma, una Glock 19, sparò tre colpi.',
    mustWrap:   ['Glock'],
    mustNotWrap:['arma', 'una', 'sparò', 'colpi'],
  },
  {
    desc: 'Mix nomi + Sheriff',
    text: 'Il Sheriff Donovan disse a Joe di andare allo Yellowstone.',
    mustWrap:   ['Sheriff', 'Donovan', 'Yellowstone'],  // Donovan ends -an: no match? hmm
    mustNotWrap:['Joe', 'andare', 'disse'],
  },
];

// Mock phonemize: returns a "*IPA[token]" placeholder string. We
// don't care about the actual IPA — only about which tokens get
// CALLED.
const calledTokens = [];
async function mockPhonemize(text, voice) {
  if (voice !== 'en-us') return '';
  calledTokens.push(text);
  return `*${text.toLowerCase()}*`;
}

let pass = 0, fail = 0;
for (const t of tests) {
  calledTokens.length = 0;
  const out = await wrapForeignWords(t.text, mockPhonemize);
  const failures = [];
  for (const w of t.mustWrap) {
    const ok = calledTokens.includes(w) && out.includes(`>${w}</phoneme>`);
    if (!ok) failures.push(`✗ ${w} NOT wrapped`);
  }
  for (const w of t.mustNotWrap) {
    if (calledTokens.includes(w)) failures.push(`✗ ${w} WAS wrapped but shouldn't`);
  }
  if (failures.length === 0) {
    pass++;
    console.log(`✅ ${t.desc}`);
    console.log(`   → ${out.slice(0, 200)}${out.length > 200 ? '…' : ''}`);
  } else {
    fail++;
    console.log(`❌ ${t.desc}`);
    console.log(`   text: ${t.text}`);
    console.log(`   wrapped tokens: [${calledTokens.join(', ')}]`);
    console.log(`   output: ${out}`);
    failures.forEach(f => console.log(`   ${f}`));
  }
}
console.log(`\n${pass}/${pass + fail} sentence tests passed (${fail} failed)`);
process.exit(fail);
