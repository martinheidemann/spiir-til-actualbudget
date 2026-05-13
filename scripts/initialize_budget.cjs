/**
 * initialize_budget.cjs
 *
 * Forbereder et Actual Budget til import af Spiir-data:
 *  1. Udleder kategorier direkte fra Spiir-CSV'en (MainCategoryName + CategoryName + CategoryType).
 *  2. Opretter manglende Spiir-grupper og -kategorier (eksisterende røres ikke).
 *  3. Opretter ekstra "Ignoreret" og "Udlæg" under "Diverse".
 *
 * Scriptet er ADDITIVT — det sletter aldrig eksisterende kategorier eller transaktioner.
 * Kan køres sikkert på et budget der allerede indeholder data fra en anden bank.
 * Er idempotent: kan køres flere gange uden bivirkninger.
 *
 * Brug:
 *   node scripts/initialize_budget.cjs <csv-fil>
 *
 * Læser ACTUAL_SERVER_URL og ACTUAL_PASSWORD fra .env i pakkens rodmappe.
 */

// --- Polyfills som @actual-app/api kræver i Node ---
if (typeof global.navigator === 'undefined') global.navigator = { platform: '', userAgent: 'node' };
if (typeof global.window === 'undefined') global.window = global;
if (typeof global.location === 'undefined') global.location = { href: '', origin: '' };

// --- Filtrer API-intern støj på stream-niveau ---
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

const SERVER_URL = process.env.ACTUAL_SERVER_URL;
const PASSWORD = process.env.ACTUAL_PASSWORD;
// .actual-data placeres i pakkens rodmappe (ikke i scripts/)
const DATA_DIR = path.join(__dirname, '..', '.actual-data');

// Første ikke-flag-argument er CSV-stien
const csvArg = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!csvArg) {
  console.error('Brug: node scripts/initialize_budget.cjs <csv-fil>');
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
if (!SERVER_URL) { console.error('Mangler ACTUAL_SERVER_URL i .env.'); process.exit(1); }
if (!PASSWORD) { console.error('Mangler ACTUAL_PASSWORD i .env.'); process.exit(1); }

// --- Undertrykker @actual-app/api interne log-beskeder ---
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
async function quietly(fn) {
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = _origLog; console.warn = _origWarn; }
}

// --- Udled kategori-struktur fra CSV ---
function deriveCategoriesFromCsv(filePath) {
  const txs = readCsvAsObjects(filePath);
  // Map: groupName → { isIncome, categories: Map<catName, type> }
  const groups = new Map();
  for (const t of txs) {
    const groupName = (t.MainCategoryName || '').trim();
    const catName = (t.CategoryName || '').trim();
    const catType = (t.CategoryType || '').trim(); // Income | Expense | Exclude
    if (!groupName || !catName) continue;
    // "Vis ikke"-gruppen håndterer vi specielt (transfers, ignoreret, udlæg)
    if (groupName === 'Vis ikke') continue;
    if (!groups.has(groupName)) groups.set(groupName, { isIncome: false, categories: new Map() });
    const g = groups.get(groupName);
    if (catType === 'Income') g.isIncome = true;
    if (!g.categories.has(catName)) g.categories.set(catName, catType);
  }
  return groups;
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  console.log(`Læser kategorier fra ${path.basename(CSV_FILE)}...`);
  const derived = deriveCategoriesFromCsv(CSV_FILE);
  console.log(`  ${derived.size} grupper, ${[...derived.values()].reduce((n, g) => n + g.categories.size, 0)} kategorier udledt fra data\n`);

  console.log('Forbinder til Actual Budget...');
  await quietly(() => api.init({ dataDir: DATA_DIR, serverURL: SERVER_URL, password: PASSWORD }));

  const budgets = await quietly(() => api.getBudgets());
  if (budgets.length === 0) {
    console.error('Ingen budgetter på serveren. Opret et tomt budget i Actual Budget UI først.');
    await quietly(() => api.shutdown());
    process.exit(1);
  }
  const budget = budgets[0];
  console.log(`Henter budget: ${budget.name}\n`);
  await quietly(() => api.downloadBudget(budget.groupId));

  // --- Hent eksisterende grupper og kategorier ---
  let existingGroups = await quietly(() => api.getCategoryGroups());
  let incomeGroup = existingGroups.find(g => g.is_income);

  // Hvis en tidligere kørsel har skabt en *expense*-version af income-gruppen,
  // flyt dens kategorier over og slet den fejlplacerede gruppe.
  const incomeGroupNames = new Set(
    [...derived.entries()].filter(([, info]) => info.isIncome).map(([name]) => name.toLowerCase())
  );
  for (const g of existingGroups) {
    if (!g.is_income && incomeGroupNames.has(g.name.toLowerCase())) {
      console.log(`\nFjerner fejlplaceret expense-gruppe: ${g.name}`);
      for (const c of (g.categories || [])) {
        try {
          await quietly(() => api.deleteCategory(c.id));
          console.log(`  Slettet kategori: ${c.name}`);
        } catch (e) {
          console.warn(`  Kunne ikke slette "${c.name}": ${e.message}`);
        }
      }
      try {
        await quietly(() => api.deleteCategoryGroup(g.id));
        console.log(`  Slettet gruppe: ${g.name}`);
      } catch (e) {
        console.warn(`  Kunne ikke slette gruppe "${g.name}": ${e.message}`);
      }
    }
  }

  // Refresh
  existingGroups = await quietly(() => api.getCategoryGroups());
  incomeGroup = existingGroups.find(g => g.is_income);
  const existingGroupByName = new Map(existingGroups.map(g => [g.name.toLowerCase(), g]));
  const existingCatNames = new Set(existingGroups.flatMap(g => (g.categories || []).map(c => c.name.toLowerCase())));

  console.log('Opretter Spiir-kategorier (eksisterende springes over)...\n');

  for (const [groupName, info] of derived) {
    let groupId;
    if (info.isIncome) {
      // Brug altid den eksisterende income-gruppe — omdøb den om nødvendigt
      if (incomeGroup) {
        groupId = incomeGroup.id;
        if (incomeGroup.name !== groupName) {
          await quietly(() => api.updateCategoryGroup(incomeGroup.id, { name: groupName }));
          console.log(`Omdøbt income-gruppe: ${incomeGroup.name} → ${groupName}`);
          incomeGroup.name = groupName;
        } else {
          console.log(`Bruger eksisterende income-gruppe: ${groupName}`);
        }
      } else {
        groupId = await quietly(() => api.createCategoryGroup({ name: groupName, is_income: true }));
        console.log(`Oprettet income-gruppe: ${groupName}`);
      }
    } else if (existingGroupByName.has(groupName.toLowerCase())) {
      groupId = existingGroupByName.get(groupName.toLowerCase()).id;
      console.log(`Gruppe findes allerede: ${groupName}`);
    } else {
      groupId = await quietly(() => api.createCategoryGroup({ name: groupName, is_income: false }));
      console.log(`Oprettet gruppe: ${groupName}`);
    }
    for (const [catName, catType] of info.categories) {
      if (existingCatNames.has(catName.toLowerCase())) {
        console.log(`  Kategori findes allerede: ${catName}`);
        continue;
      }
      await quietly(() => api.createCategory({
        name: catName,
        group_id: groupId,
        is_income: catType === 'Income',
      }));
      console.log(`  Oprettet kategori: ${catName}`);
    }
  }

  // --- Opret Ignoreret og Udlæg under Diverse (hvis de ikke allerede findes) ---
  const groupsAfter = await quietly(() => api.getCategoryGroups());
  const allCats = new Set(groupsAfter.flatMap(g => (g.categories || []).map(c => c.name.toLowerCase())));
  let diverse = groupsAfter.find(g => g.name.toLowerCase() === 'diverse');
  let diverseId = diverse?.id;
  if (!diverseId) {
    diverseId = await quietly(() => api.createCategoryGroup({ name: 'Diverse', is_income: false }));
    console.log('\nOprettet gruppe: Diverse');
  }
  for (const extra of ['Ignoreret', 'Udlæg']) {
    if (!allCats.has(extra.toLowerCase())) {
      await quietly(() => api.createCategory({ name: extra, group_id: diverseId, is_income: false }));
      console.log(`  Oprettet ekstra kategori: ${extra} (under Diverse)`);
    }
  }

  console.log('\nFærdig! Kør derefter: node scripts/import_budget.cjs <csv-fil>');
  await quietly(() => api.shutdown());
}

main().catch(async err => {
  console.error('Fejl:', err.message);
  await api.shutdown().catch(() => {});
  process.exit(1);
});
