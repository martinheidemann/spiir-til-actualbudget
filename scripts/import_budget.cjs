/**
 * import_budget.cjs
 *
 * Importerer Spiir-historik (alle-poster CSV) ind i en Actual Budget instans.
 * Forudsætter at initialize_budget.cjs er kørt først.
 *
 * Scriptet er ADDITIVT og IDEMPOTENT:
 *  - Opretter kun konti der ikke allerede eksisterer
 *  - Bruger imported_id = "spiir:<Id>" så kendte transaktioner opdateres i stedet for dublikeres
 *  - Rører ikke transaktioner fra andre banker eller manuelle posteringer
 *
 * Brug:
 *   node scripts/import_budget.cjs <csv-fil>             # rigtig kørsel
 *   node scripts/import_budget.cjs <csv-fil> --dry-run   # kun rapport, ingen import
 *
 * Læser ACTUAL_SERVER_URL og ACTUAL_PASSWORD fra .env i pakkens rodmappe.
 */

// --- Polyfills som @actual-app/api kræver i Node ---
if (typeof global.navigator === 'undefined') global.navigator = { platform: '', userAgent: 'node' };
if (typeof global.window === 'undefined') global.window = global;
if (typeof global.location === 'undefined') global.location = { href: '', origin: '' };

// --- Filtrer API-intern støj på stream-niveau (før @actual-app/api kræves,
//     da API'et gemmer console-referencer ved module-load) ---
function isApiNoise(s) {
  return typeof s === 'string' && (
    s.includes('[Breadcrumb]') ||
    /Syncing since/i.test(s) ||
    /Performing transaction reconciliation/i.test(s)
  );
}
const _origStdoutWrite = process.stdout.write.bind(process.stdout);
const _origStderrWrite = process.stderr.write.bind(process.stderr);
process.stdout.write = (chunk, ...args) => isApiNoise(chunk) ? true : _origStdoutWrite(chunk, ...args);
process.stderr.write = (chunk, ...args) => isApiNoise(chunk) ? true : _origStderrWrite(chunk, ...args);

require('./_load-env.cjs');

const api = require('@actual-app/api');
const fs = require('fs');
const path = require('path');
const { readCsvAsObjects } = require('./_csv.cjs');

// --- Konfiguration ---
const SERVER_URL = process.env.ACTUAL_SERVER_URL;
const PASSWORD = process.env.ACTUAL_PASSWORD;
const DRY_RUN = process.argv.includes('--dry-run');
// .actual-data placeres i pakkens rodmappe (ikke i scripts/)
const DATA_DIR = path.join(__dirname, '..', '.actual-data');
const BATCH_SIZE = 200;

// Første ikke-flag-argument er CSV-stien
const csvArg = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!csvArg) {
  console.error('Brug: node scripts/import_budget.cjs <csv-fil> [--dry-run]');
  process.exit(1);
}
const CSV_FILE = path.isAbsolute(csvArg) ? csvArg : path.resolve(process.cwd(), csvArg);
if (!fs.existsSync(CSV_FILE)) {
  console.error(`CSV-fil ikke fundet: ${CSV_FILE}`);
  process.exit(1);
}
if (path.extname(CSV_FILE).toLowerCase() === '.xlsx') {
  console.error('Fejl: Dette script forventer en CSV-fil, ikke en Excel-fil.');
  console.error('      Brug sync_budget.cjs til at importere budgetbeløb fra Excel:');
  console.error(`      node scripts/sync_budget.cjs "${csvArg}"`);
  process.exit(1);
}
if (!SERVER_URL && !DRY_RUN) { console.error('Mangler ACTUAL_SERVER_URL i .env.'); process.exit(1); }
if (!PASSWORD && !DRY_RUN) { console.error('Mangler ACTUAL_PASSWORD i .env.'); process.exit(1); }

// --- Hjælpefunktioner: format-konvertering ---
function parseDanishAmount(s) {
  if (!s) return 0;
  // "−50,40" eller "-50,40" → -50.40
  return Number(String(s).replace(/\s/g, '').replace(',', '.')) || 0;
}
function toIsoDate(ddmmyyyy) {
  // "25-11-2010" → "2010-11-25"
  const [d, m, y] = ddmmyyyy.split('-');
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}
// Actual API forventer beløb som heltal (øre)
function toActualAmount(kr) {
  return Math.round(kr * 100);
}

// --- Undertrykker API'ets interne console-spam (ignored: true, Syncing since, osv.) ---
const _origLog   = console.log.bind(console);
const _origWarn  = console.warn.bind(console);
const _origError = console.error.bind(console);
function print(...args)    { _origLog(...args); }
function printerr(...args) { _origError(...args); }

/** Kør en async API-funktion uden interne log-beskeder fra @actual-app/api */
async function quietly(fn) {
  const prevLog = console.log, prevWarn = console.warn, prevError = console.error;
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); }
  finally { console.log = prevLog; console.warn = prevWarn; console.error = prevError; }
}

/** Kør en async funktion med automatisk retry ved transient sync-fejl */
async function withRetry(fn, { retries = 3, delayMs = 8000, label = '' } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === retries) throw e;
      process.stdout.write('\n');
      printerr(`  Sync-fejl (forsøg ${attempt}/${retries})${label ? ' — ' + label : ''}: ${e.message}`);
      printerr(`  Prøver igen om ${delayMs / 1000} sekunder...`);
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
}

/** Undertrykk alle tre console-metoder permanent (bruges efter API-forbindelsen er oppe,
 *  så asynkrone baggrundscallbacks ikke kan lække igennem mellem quietly()-kald). */
function silenceForever() {
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
}

/** Vis en progress-bar på én linje (overskriver sig selv med \r) */
function showProgress(label, current, total) {
  const width = 28;
  const filled = total > 0 ? Math.round((current / total) * width) : width;
  const bar = '='.repeat(filled) + ' '.repeat(width - filled);
  const pct = total > 0 ? Math.round((current / total) * 100) : 100;
  process.stdout.write(`\r  [${bar}] ${String(pct).padStart(3)}%  ${current}/${total}  ${label}   `);
}

async function main() {
  print(`=== Spiir → Actual Budget import ===`);
  print(`Mode: ${DRY_RUN ? 'DRY-RUN (ingen import)' : 'LIVE (importerer)'}\n`);

  // --- Indlæs CSV ---
  print(`Læser ${path.basename(CSV_FILE)}...`);
  const txs = readCsvAsObjects(CSV_FILE);
  print(`  ${txs.length} transaktioner indlæst\n`);

  // --- Gruppér pr. konto ---
  const byAccount = new Map();
  for (const t of txs) {
    if (!byAccount.has(t.AccountName)) byAccount.set(t.AccountName, []);
    byAccount.get(t.AccountName).push(t);
  }
  print(`Konti fundet: ${[...byAccount.keys()].join(', ')}\n`);

  // --- Sortér hver konto kronologisk (ældste først) ---
  for (const arr of byAccount.values()) {
    arr.sort((a, b) => toIsoDate(a.Date).localeCompare(toIsoDate(b.Date)));
  }

  // --- Byg lookup: Spiir Id → transaktion (til transfer-matching) ---
  const byId = new Map();
  for (const t of txs) byId.set(t.Id, t);

  // --- Duplikat-detektion (kører før closing-balance-beregningen, så
  //     chain-walken kan filtrere dubletter ud). ---
  // I tidlige Spiir-importer kunne samme bankpostering komme med to gange,
  // og brugeren markerede den ene som "Ignorer" manuelt. Disse skal skippes.
  // Balance medtages i nøglen: en reel postering ændrer altid balancen.
  const dupKey = (t) => [
    t.AccountId,
    t.Date,
    parseDanishAmount(t.Amount).toFixed(2),
    (t.OriginalDescription || t.Description || '').trim(),
    parseDanishAmount(t.Balance).toFixed(2),
  ].join('|');
  const byDupKey = new Map();
  for (const t of txs) {
    const k = dupKey(t);
    if (!byDupKey.has(k)) byDupKey.set(k, []);
    byDupKey.get(k).push(t);
  }
  const skipIds = new Set();
  for (const [, group] of byDupKey) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => {
      const aIgn = a.CategoryName === 'Ignorer' ? 1 : 0;
      const bIgn = b.CategoryName === 'Ignorer' ? 1 : 0;
      if (aIgn !== bIgn) return aIgn - bIgn;
      return a.Id < b.Id ? -1 : 1;
    });
    for (let i = 1; i < sorted.length; i++) skipIds.add(sorted[i].Id);
  }

  // Ekstra deduplikering af Kontooverførsel (uden Balance i nøglen) — transfer-
  // dubletter kan have forskellig Balance end hinanden, men kun én er reel.
  const transferDupKey = (t) => [
    t.AccountId,
    t.Date,
    parseDanishAmount(t.Amount).toFixed(2),
    (t.OriginalDescription || t.Description || '').trim(),
  ].join('|');
  const byTransferDupKey = new Map();
  for (const t of txs) {
    if (t.CategoryName !== 'Kontooverførsel') continue;
    if (skipIds.has(t.Id)) continue;
    const k = transferDupKey(t);
    if (!byTransferDupKey.has(k)) byTransferDupKey.set(k, []);
    byTransferDupKey.get(k).push(t);
  }
  const transferSkipIds = new Set();
  for (const [, group] of byTransferDupKey) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => (a.Id < b.Id ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) transferSkipIds.add(sorted[i].Id);
  }

  // --- Beregn slutsaldo pr. konto via forward dag-for-dag kædning ---
  // Spiirs CSV har samme-dato-rækker i ukonsistent rækkefølge. Vi kan ikke stole på
  // "CSV's sidste række" som slutsaldo. I stedet walk'er vi forward dag for dag:
  // For hver dag bestemmer vi start-saldo (= forrige dags slut-saldo), kæder dagens
  // rækker forward via Balance→Amount, og bruger den endelige saldo som dagens slut.
  // Den allersidste dags slut = closing for kontoen.
  //
  // Vi filtrerer dubletter ud — de optræder med samme (eller korrupt) Balance i CSV
  // men bankens egentlige kæde har dem kun ÉN gang.
  //
  // For første dag (ingen forrige slut at læne sig op ad) bestemmes start ved chain-
  // start detektion: rækken hvis "balance før" (= Balance − Amount) ikke optræder som
  // nogen anden rækkes Balance i dagen. Hvis tvetydig, fallback til CSV's første række.
  function computeChronologicalEnd(arr) {
    const groups = new Map();
    for (const t of arr) {
      if (!groups.has(t.Date)) groups.set(t.Date, []);
      groups.get(t.Date).push(t);
    }
    const datesAsc = [...groups.keys()].sort((a, b) =>
      toIsoDate(a).localeCompare(toIsoDate(b)));

    let prevEnd = null;
    for (const date of datesAsc) {
      const group = groups.get(date);
      const withBal = group.filter(t => {
        const isSplitParent = t.SplitGroupId && t.SplitGroupId === t.Id;
        return !isSplitParent && t.Balance
          && !skipIds.has(t.Id) && !transferSkipIds.has(t.Id);
      });
      if (withBal.length === 0) continue;

      // Find start-of-day balance
      let startBal;
      if (prevEnd !== null) {
        startBal = prevEnd;
      } else {
        // First day: detect chain-start (row whose balance_before isn't anyone's Balance)
        const balanceSet = new Set(withBal.map(t =>
          parseDanishAmount(t.Balance).toFixed(2)));
        const starts = withBal.filter(t => {
          const before = parseDanishAmount(t.Balance) - parseDanishAmount(t.Amount);
          return !balanceSet.has(before.toFixed(2));
        });
        if (starts.length === 1) {
          startBal = parseDanishAmount(starts[0].Balance) - parseDanishAmount(starts[0].Amount);
        } else {
          // Ambiguous (or empty) — use first CSV row's balance_before as best guess
          startBal = parseDanishAmount(withBal[0].Balance) - parseDanishAmount(withBal[0].Amount);
        }
      }

      // Chain forward from startBal through the day
      let curBal = startBal;
      const used = new Set();
      while (used.size < withBal.length) {
        const next = withBal.find(t => {
          if (used.has(t.Id)) return false;
          const before = parseDanishAmount(t.Balance) - parseDanishAmount(t.Amount);
          return Math.abs(before - curBal) <= 0.01;
        });
        if (!next) break; // Chain broken
        curBal = parseDanishAmount(next.Balance);
        used.add(next.Id);
      }

      if (used.size === withBal.length) {
        // Chain completed successfully
        prevEnd = curBal;
      } else {
        // Chain broken — fallback to a Balance that's not anyone's balance_before
        const beforeBalances = new Set(withBal.map(t =>
          (parseDanishAmount(t.Balance) - parseDanishAmount(t.Amount)).toFixed(2)));
        const endCands = withBal.filter(t =>
          !beforeBalances.has(parseDanishAmount(t.Balance).toFixed(2)));
        if (endCands.length === 1) {
          prevEnd = parseDanishAmount(endCands[0].Balance);
        } else {
          // Total fallback: CSV-last row's Balance
          prevEnd = parseDanishAmount(withBal[withBal.length - 1].Balance);
        }
      }
    }
    return prevEnd ?? 0;
  }

  const closingBalances = new Map();
  for (const [acc, arr] of byAccount) {
    if (arr.length === 0) continue;
    closingBalances.set(acc, computeChronologicalEnd(arr));
  }

  // --- Klassificér transaktioner ---
  // For hver transfer-pair processerer vi kun ÉN side (den med negativt beløb / sender)
  // — så Actual selv opretter modtager-siden via transfer-payee
  const processed = new Set(); // Id'er vi har håndteret som transfer
  const stats = {
    regular: 0,
    matchedTransfers: 0,
    nameMatchedTransfers: 0,
    unmatchedTransfers: 0,
    duplicatesSkipped: 0,
    transferDuplicatesSkipped: 0,
    ignoredKept: 0,
    udlaeg: 0,
    splitParentsSkipped: 0,
    splitChildren: 0,
    oneSidedTransfers: 0,
    externalTransfers: 0,
  };
  const skippedUnmatched = [];
  const skippedDuplicates = [];
  // Til API: { accountName: [transaction, ...] }
  const toImport = new Map();
  const transferPairs = []; // {fromTx, toTx}
  const oneSidedTransfers = []; // {tx, targetAcc} — CSV har kun én side
  const externalTransferIds = new Set(); // Kontooverørsel-rækker omklassificeret til regulær Ignoreret

  for (const t of txs) {
    if (processed.has(t.Id)) continue;

    // Split-forældre: SplitGroupId peger på sin egen Id — skip dem,
    // børnene (med de reelle kategorier og beløb) importeres i stedet.
    if (t.SplitGroupId && t.SplitGroupId === t.Id) { stats.splitParentsSkipped++; continue; }

    // Duplikat: skip alle undtagen den udvalgte pr. dupKey-gruppe
    if (skipIds.has(t.Id)) {
      stats.duplicatesSkipped++;
      skippedDuplicates.push(t);
      continue;
    }

    // Transfer-dublet: Kontooverørsel-rækker med samme konto+dato+beløb+beskrivelse
    // men potentielt forskellig Balance — disse fanges ikke af den normale dupKey.
    // Køres FØR transfer-matching så dubletter ikke havner i listen over ikke-matchede overførsler.
    if (transferSkipIds.has(t.Id)) {
      stats.transferDuplicatesSkipped++;
      skippedDuplicates.push(t);
      continue;
    }

    const isKontooverforsel = t.CategoryName === 'Kontooverførsel';
    const isIgnorer = t.CategoryName === 'Ignorer';
    const isUdlaeg = t.CategoryName === 'Udlæg';

    // Ignorer uden duplikat: behold som "Ignoreret"-kategori
    if (isIgnorer) {
      stats.ignoredKept++;
      stats.regular++;
      t.__targetCategory = 'Ignoreret';
      if (!toImport.has(t.AccountName)) toImport.set(t.AccountName, []);
      toImport.get(t.AccountName).push(t);
      continue;
    }

    // Kontooverørsel: forsøg at matche par
    if (isKontooverforsel) {
      const counter = t.CounterEntryId && byId.get(t.CounterEntryId);
      if (counter && !processed.has(counter.Id)) {
        // Vi har begge sider → behandl som transfer
        const amtT = parseDanishAmount(t.Amount);
        const amtC = parseDanishAmount(counter.Amount);
        // Kun hvis de er ~modsatte
        if (Math.abs(amtT + amtC) < 0.01) {
          const fromTx = amtT < 0 ? t : counter;
          const toTx = amtT < 0 ? counter : t;
          transferPairs.push({ fromTx, toTx });
          processed.add(t.Id);
          processed.add(counter.Id);
          stats.matchedTransfers++;
          continue;
        }
      }
      // Ingen match → ekstern overførsel, spring over
      stats.unmatchedTransfers++;
      skippedUnmatched.push(t);
      continue;
    }

    // Udlæg: regulære transaktioner med dedikeret kategori "Udlæg"
    if (isUdlaeg) {
      stats.udlaeg++;
      t.__targetCategory = 'Udlæg';
    }
    if (t.SplitGroupId) stats.splitChildren++;
    stats.regular++;

    if (!toImport.has(t.AccountName)) toImport.set(t.AccountName, []);
    toImport.get(t.AccountName).push(t);
  }

  // --- Andet overførsels-pas: name-baseret matching på skippedUnmatched ---
  // Tidlige posteringer (typisk 2010-2014) mangler CounterEntryId, men afsender-siden
  // har kontonavnet som beskrivelse (fx "Fælles konto", "Grundkonto").
  // Vi finder par ved: beskrivelse indeholder et kendt kontonavn OG der er præcis én
  // umatched postering i det pågældende konto med modsatrettet beløb på samme dato.
  {
    const knownAccNames = [...byAccount.keys()];

    // Byg lookup: "accnamelower|dato|beløbFixed" → [tx, ...]
    const unmatchedLookup = new Map();
    for (const t of skippedUnmatched) {
      const k = `${t.AccountName.toLowerCase()}|${t.Date}|${parseDanishAmount(t.Amount).toFixed(2)}`;
      if (!unmatchedLookup.has(k)) unmatchedLookup.set(k, []);
      unmatchedLookup.get(k).push(t);
    }

    const nameMatchedIds = new Set();

    for (const t of [...skippedUnmatched]) {
      if (nameMatchedIds.has(t.Id)) continue;
      const desc = (t.Description || t.OriginalDescription || '').toLowerCase().trim();
      const amtT = parseDanishAmount(t.Amount);

      // Tjek om beskrivelsen indeholder et kendt kontonavn (andet end afsender-kontoen)
      let targetAcc = null;
      for (const accName of knownAccNames) {
        if (accName.toLowerCase() === t.AccountName.toLowerCase()) continue;
        if (desc.includes(accName.toLowerCase())) { targetAcc = accName; break; }
      }
      if (!targetAcc) continue;

      // Find modpart i targetAcc: modsatrettet beløb, samme dato
      const counterKey = `${targetAcc.toLowerCase()}|${t.Date}|${(-amtT).toFixed(2)}`;
      const candidates = (unmatchedLookup.get(counterKey) || []).filter(c => !nameMatchedIds.has(c.Id));
      if (candidates.length !== 1) continue; // ingen match eller tvetydig (>1)

      const counter = candidates[0];
      const fromTx = amtT < 0 ? t : counter;
      const toTx   = amtT < 0 ? counter : t;
      transferPairs.push({ fromTx, toTx });
      nameMatchedIds.add(t.Id);
      nameMatchedIds.add(counter.Id);
    }

    if (nameMatchedIds.size > 0) {
      const pairs = nameMatchedIds.size / 2;
      stats.nameMatchedTransfers = pairs;
      stats.matchedTransfers     += pairs;
      stats.unmatchedTransfers   -= nameMatchedIds.size;
      skippedUnmatched.splice(0, skippedUnmatched.length,
        ...skippedUnmatched.filter(t => !nameMatchedIds.has(t.Id)));
    }
  }

  // --- Tredje overførsels-pas: klassificér tilbageværende skippedUnmatched ---
  // De har hverken CounterEntryId-match (1. pas) eller en modpart i skippedUnmatched (2. pas).
  //
  //  A) Beskrivelsen nævner et kendt kontonavn:
  //     → Ensidet overørsel (én side mangler i CSV). Opret som rigtig Actual Budget-transfer;
  //       Actual auto-opretter modtagersiden. Åbningssaldo for afsender-kontoen justeres.
  //
  //  B) Beskrivelsen nævner intet kendt kontonavn (Juniorkonto, ekstern bank osv.):
  //     → Importér som regulær postering med kategori "Ignoreret".
  {
    const knownAccNames = [...byAccount.keys()];
    const toProcess = [...skippedUnmatched];
    skippedUnmatched.length = 0; // tøm — vi håndterer dem herunder

    for (const t of toProcess) {
      const desc = (t.Description || t.OriginalDescription || '').toLowerCase().trim();
      let targetAcc = null;
      for (const accName of knownAccNames) {
        if (accName.toLowerCase() !== t.AccountName.toLowerCase()
            && desc.includes(accName.toLowerCase())) {
          targetAcc = accName;
          break;
        }
      }

      if (targetAcc) {
        // A: ensidet overørsel til/fra kendt konto
        oneSidedTransfers.push({ tx: t, targetAcc });
        stats.oneSidedTransfers++;
        stats.unmatchedTransfers--;
      } else {
        // B: ekstern/ukendt destination → importér som regulær postering
        t.__targetCategory = 'Ignoreret';
        if (!toImport.has(t.AccountName)) toImport.set(t.AccountName, []);
        toImport.get(t.AccountName).push(t);
        externalTransferIds.add(t.Id);
        stats.externalTransfers++;
        stats.regular++;
        stats.unmatchedTransfers--;
      }
    }
  }

  // --- Beregn åbningssaldi baglæns fra slutsaldo ---
  // Garanterer at Actual Budget slutsaldo altid er korrekt, uanset om der er
  // oversprungne overførsler. Åbningssaldoen absorberer de manglende beløb.
  //
  // opening = closing − Σ(importerede posteringer på kontoen)
  //   • regulære tx'er i toImport[acc]
  //   • overførsler ud: fromTx.Amount (negativt) for par hvor fromTx.AccountName == acc
  //   • overførsler ind: toTx.Amount (positivt) for par hvor toTx.AccountName == acc
  //     (Actual auto-opretter modtager-siden, men den påvirker stadig saldoen)
  const openingBalances = new Map();
  for (const [acc] of byAccount) {
    const closing = closingBalances.get(acc) ?? 0;
    const regularSum = (toImport.get(acc) ?? [])
      .reduce((s, t) => s + parseDanishAmount(t.Amount), 0);
    let transferSum = 0;
    for (const { fromTx, toTx } of transferPairs) {
      if (fromTx.AccountName === acc) transferSum += parseDanishAmount(fromTx.Amount);
      if (toTx.AccountName   === acc) transferSum += parseDanishAmount(toTx.Amount);
    }
    // Ensidede overørsler: BEGGE sider justeres.
    // Afsender-kontoen (med CSV-rækken): tx.Amount er negativt → reducerer saldoen.
    // Modtager-kontoen (targetAcc): Actual auto-opretter en syntetisk +Amount transaktion.
    // Den transaktion er ikke i CSV, men er reel og vil påvirke saldoen i Actual Budget.
    // Vi skal derfor reducere åbningssaldoen med dette syntetiske beløb, så slutsaldoen
    // stadig passer: opening = closing − regularSum − transferSum − syntheticCredit.
    for (const { tx, targetAcc } of oneSidedTransfers) {
      if (tx.AccountName === acc) transferSum += parseDanishAmount(tx.Amount);
      // targetAcc modtager det modsatte beløb syntetisk, f.eks. tx.Amount=-5500 → +5500 på targetAcc
      if (targetAcc === acc) transferSum -= parseDanishAmount(tx.Amount);
    }
    openingBalances.set(acc, closing - regularSum - transferSum);
  }

  // --- Beregn pålidelighedsdato pr. konto (baglæns CSV-walk) ---
  // Vi starter fra nyeste transaktion (slutsaldo) og går baglæns gennem CSV.
  // For hver DAG beregner vi expected (balance ved start af dagen) ved at trække
  // dagens samlede Amount fra forrige dags slut-balance, og verificerer at expected
  // matcher mindst én af CSV-rækkernes Balance på den dato. Vi grupperer per dag fordi
  // samme-dato-rækker i CSV ikke nødvendigvis er i kronologisk rækkefølge inden for
  // dagen (eksempel: Spiir kan liste -8479 før +7429 selvom +7429 skete kronologisk
  // først). Første dag (gående bagud) hvor expected ikke matcher nogen Balance i
  // dagsgruppen markerer divergensen — alt fra dén dag og fremad er pålideligt.
  //
  // Synthetic-overførsler (modtagersiden af ensidede overf.) er IKKE i CSV;
  // hvis de mangler, dukker divergensen op netop på den dato hvor den manglende
  // kredit skulle have ramt kontoen — præcis den information vi vil vise brugeren.
  const matchedTransferIds = new Set(
    transferPairs.flatMap(p => [p.fromTx.Id, p.toTx.Id])
  );
  const oneSidedTransferTxIds = new Set(oneSidedTransfers.map(({ tx }) => tx.Id));
  const reliableSinceDates = new Map(); // acc → ISO-dato (tidligste pålidelige) eller null

  for (const [acc, arr] of byAccount) {
    let expected = closingBalances.get(acc) ?? 0;
    let lastReliableDate = null;
    let foundDivergence = false;

    // Gruppér rækker pr. dato (arr er allerede sorteret kronologisk på dato)
    const groups = new Map();
    for (const t of arr) {
      if (!groups.has(t.Date)) groups.set(t.Date, []);
      groups.get(t.Date).push(t);
    }
    const datesDesc = [...groups.keys()].sort((a, b) =>
      toIsoDate(b).localeCompare(toIsoDate(a)));

    for (const date of datesDesc) {
      const group = groups.get(date);

      // Tjek: matcher expected mindst én Balance-værdi i dagsgruppen?
      if (!foundDivergence) {
        const dayBalances = [];
        for (const t of group) {
          const isSplitParent = t.SplitGroupId && t.SplitGroupId === t.Id;
          if (!isSplitParent && t.Balance && !skipIds.has(t.Id) && !transferSkipIds.has(t.Id)) {
            dayBalances.push(parseDanishAmount(t.Balance));
          }
        }
        if (dayBalances.length > 0) {
          const matched = dayBalances.some(b => Math.abs(b - expected) <= 0.01);
          if (matched) {
            lastReliableDate = toIsoDate(date);
          } else {
            foundDivergence = true;
          }
        }
        // Hvis ingen Balance-værdier i dagen (kun split-børn), springes check over
      }

      // Walk back: træk summen af dagens contributed Amounts fra expected
      let dayAmount = 0;
      for (const t of group) {
        const isSplitParent = t.SplitGroupId && t.SplitGroupId === t.Id;
        const contributed = !isSplitParent
          && !skipIds.has(t.Id)
          && !transferSkipIds.has(t.Id)
          && (t.CategoryName !== 'Kontooverførsel'
              || matchedTransferIds.has(t.Id)
              || oneSidedTransferTxIds.has(t.Id)
              || externalTransferIds.has(t.Id));
        if (contributed) dayAmount += parseDanishAmount(t.Amount);
      }
      expected -= dayAmount;
    }

    if (lastReliableDate) reliableSinceDates.set(acc, lastReliableDate);
  }

  print(`Klassificering:`);
  print(`  Regulære transaktioner:    ${stats.regular}`);
  print(`     heraf udlæg:             ${stats.udlaeg}`);
  print(`     heraf split-børn:        ${stats.splitChildren}`);
  print(`     heraf bevarede Ignorer:  ${stats.ignoredKept}`);
  print(`  Split-forældre sprunget:   ${stats.splitParentsSkipped} (kun børn importeres)`);
  print(`  Matchede overførsler (par): ${stats.matchedTransfers}`);
  if (stats.nameMatchedTransfers > 0)
    print(`     heraf navn-matchede:     ${stats.nameMatchedTransfers} (kontonavn i beskrivelse)`);
  if (stats.oneSidedTransfers > 0)
    print(`  Ensidede overførsler:       ${stats.oneSidedTransfers} (én side mangler i CSV → syntetisk modtager)`);
  if (stats.externalTransfers > 0)
    print(`  Eksterne overførsler:       ${stats.externalTransfers} (ukendt destination → importeret som Ignoreret)`);
  print(`  Ikke-matchede overf.:       ${stats.unmatchedTransfers} (sprunget over)`);
  print(`  Dubletter sprunget over:    ${stats.duplicatesSkipped} (samme konto+dato+beløb+beskrivelse+saldo)`);
  print(`  Overf.-dubletter sprunget:  ${stats.transferDuplicatesSkipped} (Kontooverørsel, samme konto+dato+beløb)\n`);

  // --- Rapport over sprungne dubletter pr. konto ---
  function skippedSummary(label, list) {
    if (list.length === 0) return;
    print(`${label} (${list.length} poster):`);
    // Sum pr. konto
    const sumByAcc = new Map();
    for (const t of list) {
      const amt = parseDanishAmount(t.Amount);
      sumByAcc.set(t.AccountName, (sumByAcc.get(t.AccountName) || 0) + amt);
    }
    for (const [acc, sum] of [...sumByAcc].sort()) {
      const count = list.filter(t => t.AccountName === acc).length;
      print(`  ${acc.padEnd(22)} ${String(count).padStart(4)} poster   netto ${sum.toFixed(2).padStart(12)} kr`);
    }
    // Detaljer
    for (const t of list) {
      const amt = parseDanishAmount(t.Amount);
      const desc = (t.Description || t.OriginalDescription || '').slice(0, 35);
      print(`    ${t.Date}  ${t.AccountName.padEnd(18)}  ${amt.toFixed(2).padStart(10)} kr  ${desc}`);
    }
    print();
  }
  skippedSummary('Ignorer-dubletter (sprunget over)', skippedDuplicates);

  // --- Kontooversigt med åbnings-/slutsaldo og saldo-pålidelighed ---
  // Byg per-konto lister for ensidede og eksterne overørsler
  const oneSidedBySendingAcc = new Map();
  const oneSidedByReceivingAcc = new Map();
  for (const { tx, targetAcc } of oneSidedTransfers) {
    if (!oneSidedBySendingAcc.has(tx.AccountName)) oneSidedBySendingAcc.set(tx.AccountName, []);
    oneSidedBySendingAcc.get(tx.AccountName).push({ tx, targetAcc });
    if (!oneSidedByReceivingAcc.has(targetAcc)) oneSidedByReceivingAcc.set(targetAcc, []);
    oneSidedByReceivingAcc.get(targetAcc).push({ tx, targetAcc });
  }
  const externalByAcc = new Map();
  for (const [accName, list] of toImport) {
    for (const t of list) {
      if (t.__targetCategory === 'Ignoreret' && t.CategoryName === 'Kontooverførsel') {
        if (!externalByAcc.has(accName)) externalByAcc.set(accName, []);
        externalByAcc.get(accName).push(t);
      }
    }
  }

  print(`Kontooversigt (åbningssaldo beregnet baglæns fra slutsaldo):`);
  for (const [acc] of byAccount) {
    const open  = (openingBalances.get(acc) ?? 0).toFixed(2).padStart(12);
    const close = (closingBalances.get(acc) ?? 0).toFixed(2).padStart(12);
    print(`  ${acc.padEnd(22)} åbn ${open} kr  →  slut ${close} kr`);
    const reliableDate = reliableSinceDates.get(acc);
    if (reliableDate) {
      // Find første transaktion i kontoens historik for kontrast
      const firstDate = toIsoDate(byAccount.get(acc)[0].Date);
      if (reliableDate !== firstDate) {
        print(`    ✓  CSV-saldo pålidelig fra: ${reliableDate}`);
        print(`       Tidligere historik (${firstDate} → ${reliableDate}) kan have manglende posteringer`);
      }
      // Hvis reliableDate === firstDate er hele kontoens historik pålidelig — ingen advarsel
    } else {
      // Aldrig fundet en pålidelig dato — slutsaldoen passer ikke engang
      print(`    ⚠  Saldo kunne ikke verificeres mod CSV`);
    }
    const sending = oneSidedBySendingAcc.get(acc);
    if (sending?.length > 0) {
      const net   = sending.reduce((s, { tx }) => s + parseDanishAmount(tx.Amount), 0);
      const dates = sending.map(({ tx }) => toIsoDate(tx.Date)).sort();
      const netStr = (net >= 0 ? '+' : '') + net.toFixed(2);
      print(`    ↗  ${sending.length} ensidet overf. afsendt (${dates[0]} → ${dates.at(-1)}, net ${netStr} kr) — syntetisk modtager oprettet`);
    }
    const receiving = oneSidedByReceivingAcc.get(acc);
    if (receiving?.length > 0) {
      const net   = receiving.reduce((s, { tx }) => s - parseDanishAmount(tx.Amount), 0); // modsatrettet
      const dates = receiving.map(({ tx }) => toIsoDate(tx.Date)).sort();
      const netStr = (net >= 0 ? '+' : '') + net.toFixed(2);
      print(`    ↙  ${receiving.length} ensidet overf. modtaget (${dates[0]} → ${dates.at(-1)}, net ${netStr} kr) — syntetisk, ingen CSV-rækker`);
    }
    const external = externalByAcc.get(acc);
    if (external?.length > 0) {
      const net   = external.reduce((s, t) => s + parseDanishAmount(t.Amount), 0);
      const dates = external.map(t => toIsoDate(t.Date)).sort();
      const netStr = (net >= 0 ? '+' : '') + net.toFixed(2);
      print(`    ℹ  ${external.length} ekstern overf. som Ignoreret (${dates[0]} → ${dates.at(-1)}, net ${netStr} kr)`);
    }
  }
  print();

  if (DRY_RUN) {
    print('DRY-RUN — afslutter uden at importere.\n');
    return;
  }

  // --- Forbind til Actual Budget ---
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  print('Forbinder til Actual Budget...');
  await quietly(() => api.init({ dataDir: DATA_DIR, serverURL: SERVER_URL, password: PASSWORD }));

  const budgets = await quietly(() => api.getBudgets());
  if (budgets.length === 0) throw new Error('Ingen budgetter på serveren');
  const budget = budgets[0];
  print(`Henter budget: ${budget.name}\n`);
  await quietly(() => api.downloadBudget(budget.groupId));
  // Permanent suppression — asynkrone API-callbacks kan ikke lække igennem herefter
  silenceForever();

  // --- Opret/find konti ---
  print('Opretter konti (hvis ikke eksisterer)...');
  const existingAccounts = await quietly(() => api.getAccounts());
  const accountIdByName = new Map();
  for (const acc of existingAccounts) accountIdByName.set(acc.name, acc.id);

  for (const [accName, openBal] of openingBalances) {
    if (accountIdByName.has(accName)) {
      print(`  Findes: ${accName}`);
      continue;
    }
    const id = await quietly(() => api.createAccount({ name: accName, type: 'checking' }, toActualAmount(openBal)));
    accountIdByName.set(accName, id);
    print(`  Oprettet: ${accName} (åbn.saldo ${openBal.toFixed(2)} kr)`);
  }
  print();

  // --- Build kategori-lookup (CategoryName → category id) ---
  let groups = await api.getCategoryGroups();
  const categoryIdByName = new Map();
  const rebuildCategoryMap = () => {
    categoryIdByName.clear();
    for (const g of groups) {
      for (const c of (g.categories || [])) {
        categoryIdByName.set(c.name.toLowerCase(), c.id);
      }
    }
  };
  rebuildCategoryMap();

  // Sikr at "Ignoreret" og "Udlæg" kategorier findes under Diverse
  let needsRebuild = false;
  for (const extra of ['Ignoreret', 'Udlæg']) {
    if (categoryIdByName.has(extra.toLowerCase())) continue;
    let diverseGroup = groups.find(g => g.name.toLowerCase() === 'diverse');
    let diverseGroupId = diverseGroup?.id;
    if (!diverseGroupId) {
      diverseGroupId = await quietly(() => api.createCategoryGroup({ name: 'Diverse', is_income: false }));
      print('  Oprettet gruppe: Diverse');
      groups = await quietly(() => api.getCategoryGroups());
    }
    await quietly(() => api.createCategory({ name: extra, group_id: diverseGroupId, is_income: false }));
    print(`  Oprettet kategori: ${extra} (under Diverse)`);
    needsRebuild = true;
  }
  if (needsRebuild) {
    groups = await quietly(() => api.getCategoryGroups());
    rebuildCategoryMap();
  }

  // --- Build transfer-payee lookup (account id → transfer payee id) ---
  const allPayees = await quietly(() => api.getPayees());
  const transferPayeeByAccountId = new Map();
  for (const p of allPayees) {
    if (p.transfer_acct) transferPayeeByAccountId.set(p.transfer_acct, p.id);
  }

  // --- Konstruer transaktioner pr. konto ---
  const apiTxByAccount = new Map();
  function pushTx(accName, tx) {
    if (!apiTxByAccount.has(accName)) apiTxByAccount.set(accName, []);
    apiTxByAccount.get(accName).push(tx);
  }

  // Regulære
  for (const [accName, list] of toImport) {
    for (const t of list) {
      const catName = t.__targetCategory || t.CategoryName || '';
      const catId = categoryIdByName.get(catName.toLowerCase());
      // Tags droppes — Comment indeholder allerede #tag-versionen som Actual renderer korrekt
      const notes = [t.OriginalDescription, t.Comment].filter(Boolean).join(' | ');
      pushTx(accName, {
        date: toIsoDate(t.Date),
        amount: toActualAmount(parseDanishAmount(t.Amount)),
        payee_name: (t.Description || '').trim() || null,
        notes: notes || null,
        category: catId || null,
        imported_id: `spiir:${t.Id}`,
        cleared: true,
      });
    }
  }

  // Transfers (kun fra-siden — Actual auto-opretter modtager-siden via transfer payee)
  for (const { fromTx, toTx } of transferPairs) {
    const fromAccId = accountIdByName.get(fromTx.AccountName);
    const toAccId = accountIdByName.get(toTx.AccountName);
    if (!fromAccId || !toAccId) continue;
    const transferPayeeId = transferPayeeByAccountId.get(toAccId);
    if (!transferPayeeId) {
      _origWarn(`Ingen transfer-payee for ${toTx.AccountName} — springer over`);
      continue;
    }
    const notes = [fromTx.OriginalDescription, fromTx.Comment].filter(Boolean).join(' | ');
    pushTx(fromTx.AccountName, {
      date: toIsoDate(fromTx.Date),
      amount: toActualAmount(parseDanishAmount(fromTx.Amount)),
      payee: transferPayeeId,
      notes: notes || null,
      imported_id: `spiir-tx:${fromTx.Id}-${toTx.Id}`,
      cleared: true,
    });
  }

  // Ensidede overørsler: kun én side i CSV — send-siden importeres som transfer;
  // Actual auto-opretter en tilsvarende modtager-transaktion på targetAcc.
  for (const { tx, targetAcc } of oneSidedTransfers) {
    const sendingAccId = accountIdByName.get(tx.AccountName);
    const receivingAccId = accountIdByName.get(targetAcc);
    if (!sendingAccId || !receivingAccId) continue;

    // Beløbet i tx kan være enten negativt (afsender) eller positivt (modtager).
    // Vi sørger for at transfer-siden altid har et negativt beløb (penge ud).
    const amt = parseDanishAmount(tx.Amount);
    const transferAccId = amt < 0 ? receivingAccId : sendingAccId;
    const transferPayeeId = transferPayeeByAccountId.get(transferAccId);
    if (!transferPayeeId) {
      _origWarn(`Ingen transfer-payee for ensidet overørsel (${tx.AccountName} → ${targetAcc}) — springer over`);
      continue;
    }
    const notes = [tx.OriginalDescription, tx.Comment].filter(Boolean).join(' | ');
    pushTx(tx.AccountName, {
      date: toIsoDate(tx.Date),
      amount: toActualAmount(amt),
      payee: transferPayeeId,
      notes: notes || null,
      imported_id: `spiir-onesided:${tx.Id}`,
      cleared: true,
    });
  }

  // --- Importér i batches ---
  // Sync efter hver batch for at undgå at akkumulere så mange ændringer at
  // serverens body-size limit sprænges (PayloadTooLargeError).
  print('Importerer transaktioner...');
  for (const [accName, list] of apiTxByAccount) {
    const accId = accountIdByName.get(accName);
    let added = 0, updated = 0;
    // Sortér kronologisk
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      const batch = list.slice(i, i + BATCH_SIZE);
      showProgress(accName, i, list.length);
      const result = await withRetry(() => quietly(() => api.importTransactions(accId, batch)), { label: accName });
      added += result.added?.length || 0;
      updated += result.updated?.length || 0;
      // Tving sync til serveren mellem hver batch
      try { await quietly(() => api.sync()); }
      catch (e) { process.stdout.write('\n'); printerr(`  Sync-advarsel: ${e.message}`); }
    }
    showProgress(accName, list.length, list.length);
    process.stdout.write('\n');
    print(`  ${accName}: ${list.length} behandlet (tilføjet: ${added}, opdateret: ${updated})`);
  }

  // --- Marker alle transaktioner som cleared ---
  // Auto-oprettede modtager-sider af transfers arver ikke cleared-status fra
  // import-kaldet. Vi kører derfor et ekstra pas der retter alle ucleared poster
  // — alle Spiir-transaktioner er historiske og skal være cleared.
  // Eksplicitte api.sync()-kald er fjernet fra dette pas: hvert updateTransaction
  // synkroniserer internt, og et ekstra sync-kald på tværs af det giver ustabile
  // tilstande i WSL/langsom netværksmiljøer. Ét samlet sync sker til sidst.
  print('\nMarkerer ucleared transaktioner som cleared...');
  let totalCleared = 0;
  for (const [accName, accId] of accountIdByName) {
    const transactions = await quietly(() => api.getTransactions(accId));
    const uncleared = transactions.filter(t => !t.cleared);
    if (uncleared.length === 0) continue;
    for (let i = 0; i < uncleared.length; i += BATCH_SIZE) {
      const batch = uncleared.slice(i, i + BATCH_SIZE);
      showProgress(accName, i, uncleared.length);
      for (const t of batch) {
        await withRetry(() => quietly(() => api.updateTransaction(t.id, { cleared: true })));
      }
    }
    showProgress(accName, uncleared.length, uncleared.length);
    process.stdout.write('\n');
    totalCleared += uncleared.length;
    print(`  ${accName}: ${uncleared.length} poster markeret`);
  }
  if (totalCleared === 0) print('  Alle poster var allerede cleared.');

  // Afsluttende sync efter alle cleared-opdateringer
  try { await withRetry(() => quietly(() => api.sync())); }
  catch (e) { printerr(`  Advarsel: afsluttende sync fejlede: ${e.message}`); }

  try { await quietly(() => api.shutdown()); } catch (e) { /* shutdown syncer internt — ignorer fejl */ }
  print('\nFærdig! Husk at sammenligne slutsaldi ovenfor med Actual Budget.');
}

// Fang uventede async-fejl fra @actual-app/api's interne sync-operationer.
// Disse kastes som unhandledRejection og crasher Node ellers uden at blive fanget
// af main().catch() — fx hvis api.updateTransaction internt kicker en sync i gang
// der fejler asynkront.
process.on('unhandledRejection', (reason) => {
  const msg = reason?.message || String(reason);
  if (msg.includes('api/sync') || msg.includes('network-failure') || msg.includes('getSyncError')) {
    // Transient sync-fejl fra Actual Budget API — log og ignorer.
    // Scriptet er idempotent: køres det igen, importeres kun det der mangler.
    printerr(`\n  Advarsel: intern sync-fejl ignoreret: ${msg}`);
    printerr('  Kør scriptet igen hvis noget mangler — det fortsætter fra der af.');
  } else {
    printerr('\nUventet fejl:', msg);
    process.exit(1);
  }
});

main().catch(async err => {
  // Vis fejltype og reason hvis det er en sync/PostError
  const reason = err.reason || err.type || '';
  printerr('\nFejl:', err.message || '(ingen besked)');
  if (reason) printerr('Årsag:', reason);
  printerr(err.stack);
  if (reason === 'network-failure' || err.message?.includes('network-failure')) {
    printerr('\nTip: Actual Budget serveren afviste sync-kaldet (network-failure).');
    printerr('     Prøv at køre scriptet igen — det fortsætter fra der af.');
    printerr('     Hvis fejlen gentager sig: slet budgettet i Actual Budget UI og start forfra.');
  }
  try { await api.shutdown(); } catch {}
  process.exit(1);
});
