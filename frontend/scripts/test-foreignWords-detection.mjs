// scripts/test-foreignWords-detection.mjs — v1.0.4 EXPANDED MATRIX
//
// Standalone offline test of the v1.0.4 regex/pattern detector.
// Validates the 7 detection tiers against:
//   - thriller-specific proper nouns (Glock, Bosch, Connelly, …)
//   - morphological suffixes (-tion, -ing, -wood, -ton, …)
//   - non-italian initial clusters (kn-, wr-, tw-, sw-, chr-, …)
//   - hard consonant endings (-d, -t, -k, -p, -b, -g, -f, -ght, …)
//   - vowel pairs (oo, ee, oa, ou, ey, ow, ay)
//   - acclimatised italian (sport, hotel, computer, weekend, …) → MUST NOT match
//   - pure italian (ciao, città, voltò, Marco, anno) → MUST NOT match

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
  'donovan','sullivan','jackson','wilson','johnson','thompson',
  'kevin','colin','martin','austin','donald','ronald',
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
const RE_EN_PREFIXES = [
  /^kn/i, /^wr/i, /^ps/i, /^tw/i, /^sw/i, /^chr/i, /^thr/i,
];
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

function tokenIsLoanword(t) { return classifyToken(t) !== null; }

const cases = [
  // ───── Tier-A clusters (consonant digraphs/trigraphs) ─────
  ['Glock',    true, 'cluster:ck'],
  ['Bosch',    true, 'cluster:sch'],
  ['Smith',    true, 'cluster:th'],
  ['Phoenix',  true, 'cluster:ph'],
  ['Whitney',  true, 'cluster:wh'],
  ['Charlie',  true, 'cluster:ch (not -e/i)'],
  ['Mitchell', true, 'cluster:tch'],
  ['Edge',     true, 'cluster:dg'],
  ['Bridge',   true, 'cluster:dg'],
  ['Shrek',    true, 'cluster:shr'],
  // ───── Tier-B final clusters / hard endings ─────
  ['Mark',     true, 'final:ark (-rk)'],
  ['Strong',   true, 'final:-ong (-ng)'],
  ['Tough',    true, 'final:-gh'],
  ['Night',    true, 'final:-ght'],
  ['Fact',     true, 'final:-ct'],
  ['Lamb',     true, 'final:-mb'],
  ['Camp',     true, 'final:-mp'],
  ['Soft',     true, 'final:-ft'],
  ['Stop',     true, 'final:-p after vowel'],
  ['Bob',      true, 'final:-b after vowel'],
  ['Good',     true, 'final:-d after vowel'],
  ['But',      true, 'final:-t after vowel'],
  ['Big',      true, 'final:-g after vowel'],
  ['Connelly', true, 'final:[^aeiou]y$'],
  // ───── Tier-C vowel pairs ─────
  ['Lee',      true, 'vowel:ee'],
  ['Bloomberg',true, 'vowel:oo'],
  ['Brown',    true, 'vowel:ow'],
  ['Road',     true, 'vowel:oa'],
  ['Ground',   true, 'vowel:ou'],
  ['Grey',     true, 'vowel:ey'],
  ['Sunday',   true, 'vowel:ay'],
  // ───── Tier-D morphological suffixes ─────
  ['Action',   true, 'suffix:tion'],
  ['Mission',  true, 'suffix:sion'],
  ['King',     true, 'suffix:ing'],
  ['Named',    true, 'suffix:ed'],
  ['Hopeless', true, 'suffix:less'],
  ['Madness',  true, 'suffix:ness'],
  ['Useful',   true, 'suffix:ful'],
  ['Steinberg',true, 'suffix:berg'],
  ['Goldstein',true, 'suffix:stein'],
  // ───── Tier-E compound endings ─────
  ['Hollywood',true, 'compound:wood'],
  ['Springfield',true, 'compound:field'],
  ['Washington',true,'compound:ton'],
  ['Nashville',true, 'compound:ville'],
  ['Bradford', true, 'compound:ford'],
  ['Yorkshire',true, 'compound:shire'],
  ['Marlborough',true,'compound:borough'],
  ['Johnson',  true, 'compound:son (PROPER also)'],
  ['Sherman',  true, 'compound:man'],
  // ───── Tier-F initial clusters ─────
  ['Knight',   true, 'prefix:kn'],
  ['Knee',     true, 'prefix:kn'],
  ['Wright',   true, 'prefix:wr'],
  ['Twins',    true, 'prefix:tw'],
  ['Sweet',    true, 'prefix:sw'],
  ['Swan',     true, 'prefix:sw'],
  ['Christopher',true,'prefix:chr'],
  // ───── Tier-G patronymic ─────
  ['McCaleb',   true, 'patronymic Mc'],
  ['MacDonald', true, 'patronymic Mac'],
  ["O'Brien",   false, "O' prefix has apostrophe → ASCII guard rejects (token will be split by tokenizer anyway)"],
  // ───── URBAN keywords ─────
  ['Broadway', true, 'URBAN broadway'],
  ['Avenue',   true, 'URBAN avenue'],
  ['Highway',  true, 'URBAN highway'],
  ['Sheriff',  true, 'URBAN sheriff'],
  // ───── PROPER names ─────
  ['Manhattan',true, 'PROPER'],
  ['Sunset',   true, 'PROPER'],
  ['Vegas',    true, 'PROPER'],
  ['Hollywood',true, 'PROPER'],
  ['Donovan',  true, 'PROPER'],
  // ───── ITALIAN WHITELIST (must NOT match) ─────
  ['sport',    false, 'whitelist'],
  ['hotel',    false, 'whitelist'],
  ['weekend',  false, 'whitelist'],
  ['computer', false, 'whitelist'],
  ['internet', false, 'whitelist'],
  ['fashion',  false, 'whitelist'],
  ['manager',  false, 'whitelist'],
  ['club',     false, 'whitelist'],
  ['shock',    false, 'whitelist'],
  ['stress',   false, 'whitelist'],
  // ───── PURE ITALIAN (must NOT match) ─────
  ['ciao',     false, 'pure italian'],
  ['casa',     false, 'pure italian'],
  ['amore',    false, 'pure italian'],
  ['perché',   false, 'accented italian (ASCII guard)'],
  ['città',    false, 'accented italian'],
  ['voltò',    false, 'accented italian (homograph)'],
  ['guardò',   false, 'accented italian'],
  ['Italia',   false, 'italian + capital'],
  ['Roma',     false, 'italian + capital'],
  ['Marco',    false, 'italian (no cluster, ends -o)'],
  ['Carlo',    false, 'italian (no cluster)'],
  ['Andrea',   false, 'italian (no cluster)'],
  ['Stefano',  false, 'italian (no -ed suffix risk — ends -no)'],
  ['anno',     false, 'italian (double-n)'],
  ['otto',     false, 'italian (double-t, ends vowel)'],
  ['mano',     false, 'italian (ends -no)'],
  ['Marin',    false, 'italian surname ends -in (no -n in regex)'],
  ['Pavan',    false, 'italian surname ends -an'],
  ['del',      false, 'too short'],
  ['nel',      false, 'too short'],
  ['di',       false, 'too short'],
  // ───── REAL ITALIAN that COULD have triggered older regex ─────
  ['fotografia',false,'italian (no cluster)'],
  ['lavoro',   false, 'italian'],
  ['parlare',  false, 'italian (no cluster, ends -re)'],
  ['Beatrice', false, 'italian: contains "ea" but we excluded /ea/'],
  ['idea',     false, 'italian: contains "ea" but excluded'],
  ['linea',    false, 'italian: contains "ea" but excluded'],
  ['Paolo',    false, 'italian: contains "ao" but no cluster matched'],
  ['auto',     false, 'italian: au+to, /au/ excluded'],
  ['mai',      false, 'italian: ai excluded'],
  ['dai',      false, 'italian: ai excluded'],
];

let pass = 0, fail = 0;
const failed = [];
for (const [tok, expected, why] of cases) {
  const reason = classifyToken(tok);
  const got = reason !== null;
  const ok = got === expected;
  if (ok) pass++;
  else { fail++; failed.push({ tok, expected, got, reason, why }); }
  const marker = ok ? '✅' : '❌';
  const rPad = (reason || '').padEnd(20);
  console.log(`${marker} ${tok.padEnd(14)} expected=${String(expected).padEnd(5)} got=${String(got).padEnd(5)} reason=${rPad}  (${why})`);
}
console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  - ${f.tok}: expected ${f.expected}, got ${f.got} (reason=${f.reason}) — ${f.why}`);
}
process.exit(fail);
