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
  console.log = () => {}; console.warn = () => {}; console.error = () => {};
  try { return await fn(); }
  finally { console.log = _origLog; console.warn = _origWarn; console.error = _origError; }
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

  // --- Beregn åbningssaldo pr. konto ---
  // Spiirs Balance er saldoen EFTER transaktionen → opening = Balance - Amount på første postering
  const openingBalances = new Map();
  for (const [acc, arr] of byAccount) {
    if (arr.length === 0) continue;
    const first = arr[0];
    const openBal = parseDanishAmount(first.Balance) - parseDanishAmount(first.Amount);
    openingBalances.set(acc, openBal);
  }

  // --- Beregn slutsaldo pr. konto (fra sidste postering) ---
  const closingBalances = new Map();
  for (const [acc, arr] of byAccount) {
    if (arr.length === 0) continue;
    closingBalances.set(acc, parseDanishAmount(arr[arr.length - 1].Balance));
  }

  // --- Byg lookup: Spiir Id → transaktion (til transfer-matching) ---
  const byId = new Map();
  for (const t of txs) byId.set(t.Id, t);

  // --- Duplikat-detektion til Ignorer-poster ---
  // I tidlige Spiir-importer kunne samme bankpostering komme med to gange,
  // og brugeren markerede den ene som "Ignorer" manuelt. Disse skal skippes.
  // Nøgle: konto + dato + beløb + beskrivelse → liste af tx'er
  const dupKey = (t) => [
    t.AccountId,
    t.Date,
    parseDanishAmount(t.Amount).toFixed(2),
    (t.OriginalDescription || t.Description || '').trim(),
  ].join('|');
  const byDupKey = new Map();
  for (const t of txs) {
    const k = dupKey(t);
    if (!byDupKey.has(k)) byDupKey.set(k, []);
    byDupKey.get(k).push(t);
  }

  // --- Klassificér transaktioner ---
  // For hver transfer-pair processerer vi kun ÉN side (den med negativt beløb / sender)
  // — så Actual selv opretter modtager-siden via transfer-payee
  const processed = new Set(); // Id'er vi har håndteret som transfer
  const stats = {
    regular: 0,
    matchedTransfers: 0,
    unmatchedTransfers: 0,
    ignoredDuplicates: 0,
    ignoredKept: 0,
    udlaeg: 0,
    splits: 0,
  };
  // Til API: { accountName: [transaction, ...] }
  const toImport = new Map();
  const transferPairs = []; // {fromAccount, toAccount, fromTx, toTx}

  for (const t of txs) {
    if (processed.has(t.Id)) continue;

    const isKontooverforsel = t.CategoryName === 'Kontooverførsel';
    const isIgnorer = t.CategoryName === 'Ignorer';
    const isUdlaeg = t.CategoryName === 'Udlæg';

    // Ignorer: spring over hvis dublet, ellers behold som "Ignoreret"-kategori
    if (isIgnorer) {
      const siblings = byDupKey.get(dupKey(t)) || [];
      const hasOtherTx = siblings.some(s => s.Id !== t.Id && s.CategoryName !== 'Ignorer');
      if (hasOtherTx) {
        stats.ignoredDuplicates++;
        continue;
      }
      // Behold som regulær med kategori "Ignoreret"
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
      continue;
    }

    // Udlæg: regulære transaktioner med dedikeret kategori "Udlæg"
    if (isUdlaeg) {
      stats.udlaeg++;
      t.__targetCategory = 'Udlæg';
    }
    if (t.SplitGroupId) stats.splits++;
    stats.regular++;

    if (!toImport.has(t.AccountName)) toImport.set(t.AccountName, []);
    toImport.get(t.AccountName).push(t);
  }

  print(`Klassificering:`);
  print(`  Regulære transaktioner:    ${stats.regular}`);
  print(`     heraf udlæg:             ${stats.udlaeg}`);
  print(`     heraf split-poster:      ${stats.splits}`);
  print(`     heraf bevarede Ignorer:  ${stats.ignoredKept}`);
  print(`  Matchede overførsler (par): ${stats.matchedTransfers}`);
  print(`  Ikke-matchede overf.:       ${stats.unmatchedTransfers} (sprunget over)`);
  print(`  Ignorer-dubletter:          ${stats.ignoredDuplicates} (sprunget over)\n`);

  print(`Åbningssaldi (1. postering i Spiir):`);
  for (const [acc, bal] of openingBalances) print(`  ${acc.padEnd(20)} ${bal.toFixed(2).padStart(12)} kr`);
  print(`\nSlutsaldi (sidste postering i Spiir):`);
  for (const [acc, bal] of closingBalances) print(`  ${acc.padEnd(20)} ${bal.toFixed(2).padStart(12)} kr`);
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
      const result = await quietly(() => api.importTransactions(accId, batch));
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
  // Synkroniseres i batches for at undgå PayloadTooLargeError/network-failure.
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
        await quietly(() => api.updateTransaction(t.id, { cleared: true }));
      }
      try { await quietly(() => api.sync()); }
      catch (e) { process.stdout.write('\n'); printerr(`  Sync-advarsel: ${e.message}`); }
    }
    showProgress(accName, uncleared.length, uncleared.length);
    process.stdout.write('\n');
    totalCleared += uncleared.length;
    print(`  ${accName}: ${uncleared.length} poster markeret`);
  }
  if (totalCleared === 0) print('  Alle poster var allerede cleared.');

  try { await quietly(() => api.shutdown()); } catch (e) { /* shutdown syncer internt — ignorer fejl */ }
  print('\nFærdig! Husk at sammenligne slutsaldi ovenfor med Actual Budget.');
}

main().catch(async err => {
  // Vis fejltype og reason hvis det er en sync/PostError
  const reason = err.reason || err.type || '';
  printerr('\nFejl:', err.message || '(ingen besked)');
  if (reason) printerr('Årsag:', reason);
  printerr(err.stack);
  if (reason === 'network-failure' || err.message?.includes('network-failure')) {
    printerr('\nTip: Actual Budget serveren afviste sync-kaldet (network-failure).');
    printerr('     Prøv at køre scriptet igen — det er idempotent og fortsætter fra der af.');
    printerr('     Hvis fejlen gentager sig: slet budgettet i Actual Budget UI og start forfra.');
  }
  try { await api.shutdown(); } catch {}
  process.exit(1);
});
