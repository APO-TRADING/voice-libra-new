// scripts/test-foreignWords-detection.mjs
//
// Standalone offline test of the v1.0.4 regex/pattern detector in
// foreignWords.ts. This DOES NOT call the native phonemizer (which
// only exists in the Android build). It only validates that the
// loanword classifier (tokenIsLoanword) correctly flags the words
// we care about and ignores acclimatised italian words.
//
// Run:  cd /app/frontend && node scripts/test-foreignWords-detection.mjs
//
// Exit code = number of failures (0 if all pass).

// We re-implement the exact same rules here to avoid pulling in the
// expo asset / async-storage runtime that the real foreignWords.ts
// depends on. The rules MUST stay in lock-step with the production
// file.

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

const PROPER_NAMES_EN = new Set([
  'manhattan','sunset','hollywood','harlem','bronx','queens','vegas',
  'donovan','sullivan','jackson','wilson','johnson','thompson',
  'kevin','colin','martin','austin','donald','ronald',
]);

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

const cases = [
  // Should be detected (true)
  ['Glock', true, 'ck cluster (gun brand)'],
  ['Bosch', true, 'sh cluster (Connelly char)'],
  ['Connelly', true, 'double-l + ee... wait, no. ck/sh/th? actually `lly` … hmm'],
  ['Smith', true, 'th cluster'],
  ['Thompson', true, 'th cluster + Mc-style'],
  ['Phoenix', true, 'ph cluster'],
  ['Whitney', true, 'wh cluster'],
  ['Knight', true, 'gh non-italian context'],
  ['Lee', true, 'double-e'],
  ['Bloomberg', true, 'double-o'],
  ['Brown', true, 'ow ending'],
  ['Broadway', true, 'URBAN keyword'],
  ['Highway', true, 'URBAN keyword'],
  ['McCaleb', true, 'Mc patronymic'],
  ['MacDonald', true, 'Mac patronymic'],
  ['Dudee', true, 'double-e (test name)'],
  ['Dundee', true, 'double-e'],
  ['Mark', true, 'final -rk after vowel'],
  ['Charlie', true, 'ch + ie ... uh, lemme check the regex'],
  ['Street', true, 'URBAN keyword'],
  ['Avenue', true, 'URBAN keyword'],
  ['Sheriff', true, 'sh + URBAN'],

  // Should NOT be detected (false)
  ['sport', false, 'whitelist'],
  ['hotel', false, 'whitelist'],
  ['weekend', false, 'whitelist'],
  ['computer', false, 'whitelist'],
  ['internet', false, 'whitelist'],
  ['ciao', false, 'pure italian'],
  ['casa', false, 'pure italian'],
  ['amore', false, 'pure italian'],
  ['perché', false, 'accented italian (rejected by ASCII check)'],
  ['città', false, 'accented italian'],
  ['voltò', false, 'accented italian'],
  ['Italia', false, 'italian + capital'],
  ['Roma', false, 'italian + capital'],
  ['la', false, 'too short'],
  ['il', false, 'too short'],
  ['di', false, 'too short'],
  // Italian words that contain double cons/vowels but should not match:
  ['anno', false, 'italian double-n (no en cluster)'],
  ['otto', false, 'italian double-t'],
  ['Carlo', false, 'italian name (no clusters)'],
  ['Andrea', false, 'italian name'],
  ['mano', false, 'italian (no cluster)'],
];

let pass = 0, fail = 0;
const failed = [];
for (const [tok, expected, why] of cases) {
  const got = tokenIsLoanword(tok);
  const ok = got === expected;
  if (ok) pass++;
  else { fail++; failed.push({ tok, expected, got, why }); }
  console.log(`${ok ? '✅' : '❌'} ${tok.padEnd(14)} expected=${expected} got=${got}   (${why})`);
}
console.log(`\n${pass}/${pass + fail} passed, ${fail} failed`);
if (failed.length) {
  console.log('\nFAILURES:');
  for (const f of failed) console.log(`  - ${f.tok}: expected ${f.expected}, got ${f.got} (${f.why})`);
}
process.exit(fail);
