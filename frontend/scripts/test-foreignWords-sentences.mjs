// scripts/test-foreignWords-sentences.mjs — v1.0.4 EXPANDED MATRIX
// End-to-end smoke test for wrapForeignWords() with the full 7-tier
// regex set on realistic thriller sentences.

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
  'manhattan','sunset','hollywood','harlem','bronx','queens','vegas',
  'seattle','boston','denver','houston','austin','dallas','miami',
  'atlanta','memphis','detroit','portland','pittsburgh','baltimore',
  'philly','newark','staten','westwood','beverly','malibu','venice',
  'pasadena','compton','oakland','berkeley','sacramento',
  'london','thames','soho','camden','chelsea',
  'donovan','sullivan','callahan','flanagan','morgan','reagan','sloan',
  'logan','cohen','allen','jordan','nolan','lawson','jackson','wilson',
  'johnson','jefferson','anderson','robinson','thompson','harrison',
  'peterson','davidson','henderson',
  'kevin','gavin','devin','colin','martin','justin','austin',
  'kenneth','harold','gerald','donald','ronald','arnold','sheldon',
]);

const RE_ENGLISH_CLUSTERS = [
  /ck/i, /sh/i, /shr/i, /sch/i, /th/i, /ph/i, /wh/i,
  /ch(?![eiy])/i, /gh(?![ei])/i, /dg/i, /tch/i,
];
const RE_FINAL_CLUSTERS = [
  /[aeiou](?:nd|rd|ld|rg|rk|rt|ck|lk|ng|st|sk|ct|pt|ft|mp|mb|nt|nk|sp|lt|lf|lp|ls|lm)$/i,
  /[aeiou][tdgkpbf]$/i,
  /(?:gh|ght)$/i,
  /[^aeiou]y$/i,
];
const RE_VOWEL_PAIRS = [
  /ee/i, /oo/i, /oa/i, /ou/i,
  /ay(?:$|[^aeiouy])/i,
  /ey(?:$|[^aeiouy])/i,
  /ow(?:$|[^aeiouy])/i,
];
const RE_EN_SUFFIXES = [
  /tion$/i, /sion$/i, /ing$/i, /ed$/i, /less$/i, /ness$/i,
  /ful$/i, /ment$/i, /ship$/i, /hood$/i, /ward$/i,
  /berg$/i, /stein$/i,
];
const RE_EN_COMPOUNDS = [
  /wood$/i, /town$/i, /field$/i, /ton$/i, /glen$/i,
  /ville$/i, /ford$/i, /shire$/i, /borough$/i, /worth$/i,
  /man$/i, /son$/i,
];
const RE_EN_PREFIXES = [/^kn/i, /^wr/i, /^ps/i, /^tw/i, /^sw/i, /^chr/i, /^thr/i];
const RE_PATRONYMIC = /^(?:Mc|Mac|O')[A-Z]/;

function classifyToken(token) {
  if (token.length < 3) return null;
  for (let i = 0; i < token.length; i++) {
    const c = token.charCodeAt(i);
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    if (!(isUpper || isLower)) return null;
  }
  const lower = token.toLowerCase();
  if (ITALIAN_WHITELIST.has(lower)) return null;
  if (URBAN_KEYWORDS.has(lower)) return 'URBAN';
  if (PROPER_NAMES_EN.has(lower)) return 'PROPER';
  if (RE_PATRONYMIC.test(token)) return 'patronymic';
  for (const re of RE_ENGLISH_CLUSTERS) { const m = re.exec(token); if (m) return `cluster:${m[0]}`; }
  for (const re of RE_FINAL_CLUSTERS)   { const m = re.exec(token); if (m) return `final:${m[0]}`; }
  for (const re of RE_VOWEL_PAIRS)      { const m = re.exec(token); if (m) return `vowel:${m[0]}`; }
  for (const re of RE_EN_SUFFIXES)      { const m = re.exec(token); if (m) return `suffix:${m[0]}`; }
  for (const re of RE_EN_COMPOUNDS)     { const m = re.exec(token); if (m) return `compound:${m[0]}`; }
  for (const re of RE_EN_PREFIXES)      { const m = re.exec(token); if (m) return `prefix:${m[0]}`; }
  return null;
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
    const reason = classifyToken(chunk);
    if (!reason) continue;
    matches.push({ start: m.index, end: m.index + chunk.length, token: chunk, reason });
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

const tests = [
  {
    desc: 'Glock + verbo italiano',
    text: 'Lui impugnò la Glock e sparò.',
    mustWrap:   ['Glock'],
    mustNotWrap:['impugnò', 'sparò'],
  },
  {
    desc: 'Personaggio Connelly + ambientazione US',
    text: 'Harry Bosch, il detective di Los Angeles, parlò con Michael Connelly.',
    mustWrap:   ['Harry', 'Bosch', 'detective', 'Michael', 'Connelly'],
    mustNotWrap:['di', 'Los', 'Angeles', 'parlò'],
  },
  {
    desc: 'Indirizzo americano (Sunset Boulevard, Broadway)',
    text: 'Camminò lungo Sunset Boulevard fino a Broadway.',
    mustWrap:   ['Sunset', 'Boulevard', 'Broadway'],
    mustNotWrap:['lungo', 'fino'],
  },
  {
    desc: 'Italianismi (sport, hotel, weekend) NON intercettati',
    text: 'Ha prenotato un hotel e poi fa sport tutti i weekend.',
    mustWrap:   [],
    mustNotWrap:['hotel', 'sport', 'weekend'],
  },
  {
    desc: 'Patronimici Mc/Mac + cluster (Charlie, Knight, Mitchell)',
    text: 'McCaleb arrivò con Charlie, Knight e Mitchell.',
    mustWrap:   ['McCaleb', 'Charlie', 'Knight', 'Mitchell'],
    mustNotWrap:['con'],
  },
  {
    desc: 'Manhattan + Vegas + Hollywood (PROPER_NAMES_EN)',
    text: 'Da Manhattan a Las Vegas, passando per Hollywood.',
    mustWrap:   ['Manhattan', 'Vegas', 'Hollywood'],
    mustNotWrap:['passando'],
  },
  {
    desc: 'Suffissi morfologici (Sterling, Goldberg, Action)',
    text: 'Sterling lavorò con Goldberg sull\'operazione Action.',
    mustWrap:   ['Sterling', 'Goldberg', 'Action'],
    mustNotWrap:['operazione', 'lavorò'],   // "operazione" ends -one → italian
  },
  {
    desc: 'Compound endings (Hollywood, Springfield, Washington)',
    text: 'Da Hollywood a Springfield, passando per Washington.',
    mustWrap:   ['Hollywood', 'Springfield', 'Washington'],
    mustNotWrap:['passando'],
  },
  {
    desc: 'Prefissi non italiani (Wright, Christopher, Sweet)',
    text: 'Wright e Christopher andarono al Sweet Bar.',
    mustWrap:   ['Wright', 'Christopher', 'Sweet'],
    mustNotWrap:['andarono'],
  },
  {
    desc: 'Hard endings (-d, -t, -k) per Road, Mark, Brad',
    text: 'Marco e Brad camminarono lungo la Mark Road.',
    mustWrap:   ['Brad', 'Mark', 'Road'],
    mustNotWrap:['Marco', 'camminarono'],
  },
  {
    desc: 'Vowel pairs (Bloomberg, Ground, Grey)',
    text: 'Bloomberg parlò del Ground Zero in modo Grey.',
    mustWrap:   ['Bloomberg', 'Ground', 'Grey'],
    mustNotWrap:['parlò', 'modo'],
  },
  {
    desc: 'Omografi italiani con cluster forzosi (voltò, guardò)',
    text: 'Si voltò verso il muro e guardò la fotografia.',
    mustWrap:   [],
    mustNotWrap:['voltò', 'guardò', 'fotografia', 'verso', 'muro'],
  },
  {
    desc: 'Italian-but-tricky (Beatrice, Paolo, Andrea — vowel-pair traps)',
    text: 'Beatrice e Paolo, con Andrea, andarono al cinema.',
    mustWrap:   [],
    mustNotWrap:['Beatrice', 'Paolo', 'Andrea', 'cinema', 'andarono'],
  },
  {
    desc: 'Frase italiana lunga (nessun match)',
    text: 'La donna alzò lentamente lo sguardo dalla pagina del libro che stava leggendo.',
    mustWrap:   [],
    mustNotWrap:['donna', 'alzò', 'sguardo', 'pagina', 'libro', 'leggendo'],
  },
  {
    desc: 'Mix nomi (Sheriff Donovan + Yellowstone)',
    text: 'Il Sheriff Donovan disse a Joe di andare allo Yellowstone.',
    mustWrap:   ['Sheriff', 'Donovan', 'Yellowstone'],
    mustNotWrap:['Joe', 'andare', 'disse'],
  },
];

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
    console.log(`   → ${out.slice(0, 240)}${out.length > 240 ? '…' : ''}`);
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
