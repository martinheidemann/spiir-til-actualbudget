/**
 * sync_budget.cjs
 *
 * Importerer budgetbeløb fra en Spiir Excel-budgetfil til Actual Budget.
 * Scriptet er ADDITIVT og IDEMPOTENT — kørsel sætter/overskriver kun de
 * måneds-/kategori-kombinationer der er nævnt i Excel-filen.
 *
 * Excel-format (Spiir Budget 2026/2027.xlsx):
 *   Kolonne A: Sektionsoverskrift
 *   Kolonne B: Kategorinavn (fx "Dagligvarer", "Martin", "Bar, cafe & restaurant")
 *   Kolonne C: Gns/md (formel — ignoreres)
 *   Kolonne D: Årligt (formel — ignoreres)
 *   Kolonne E-P: Budgetbeløb for Jan–Dec
 *
 * Kategorinavne i Excel der afviger fra Actual Budget-navne kan mappes i
 * budget-mapping.json. Rækker der mapper til samme kategori summeres pr. måned.
 *
 * Brug:
 *   node scripts/sync_budget.cjs <excel-fil>             # rigtig kørsel
 *   node scripts/sync_budget.cjs <excel-fil> --dry-run   # rapport uden ændringer
 *
 * Læser ACTUAL_SERVER_URL og ACTUAL_PASSWORD fra .env i pakkens rodmappe.
 */

// --- Polyfills som @actual-app/api kræver i Node ---
if (typeof global.navigator === 'undefined') global.navigator = { platform: '', userAgent: 'node' };
if (typeof global.window === 'undefined') global.window = global;
if (typeof global.location === 'undefined') global.location = { href: '', origin: '' };

require('./_load-env.cjs');

const api = require('@actual-app/api');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SERVER_URL = process.env.ACTUAL_SERVER_URL;
const PASSWORD = process.env.ACTUAL_PASSWORD;
const DRY_RUN = process.argv.includes('--dry-run');
const DATA_DIR = path.join(__dirname, '..', '.actual-data');
const MAPPING_FILE = path.join(__dirname, 'budget-mapping.json');

// Første ikke-flag-argument er Excel-stien
const xlsxArg = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!xlsxArg) {
  console.error('Brug: node scripts/sync_budget.cjs <excel-fil> [--dry-run]');
  process.exit(1);
}
const XLSX_FILE = path.isAbsolute(xlsxArg) ? xlsxArg : path.resolve(process.cwd(), xlsxArg);
if (!fs.existsSync(XLSX_FILE)) {
  console.error(`Excel-fil ikke fundet: ${XLSX_FILE}`);
  process.exit(1);
}
if (!SERVER_URL && !DRY_RUN) { console.error('Mangler ACTUAL_SERVER_URL i .env.'); process.exit(1); }
if (!PASSWORD && !DRY_RUN) { console.error('Mangler ACTUAL_PASSWORD i .env.'); process.exit(1); }

// Månedsnavne som de optræder i Excel (dansk Spiir-eksport)
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
// Alternativt engelske navne for robusthed
const MONTH_NAMES_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Rækker der er totaler/overskrifter og skal springes over
const SKIP_PATTERNS = [
  /ialt/i,
  /total/i,
  /forbrug/i,   // "Forbrug ialt"
  /indkomst ialt/i,
  /^gns/i,
  /^årligt/i,
];

function isSkipRow(name) {
  if (!name || !name.trim()) return true;
  return SKIP_PATTERNS.some(p => p.test(name.trim()));
}

/**
 * Parser Excel-filen og returnerer en liste af:
 *   { categoryName, monthIndex (0-11), amountDKK }
 */
function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  // raw: true returnerer numeriske celleværdier som JavaScript-tal (undgår danske
  // tusindtals-separator-problemer, hvor "8.000" ellers fejltolkes som 8,0 i stedet for 8000).
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  // Find rækken der indeholder måneds-overskrifter (E-P kolonner)
  let headerRowIdx = -1;
  let monthColIndices = []; // array of { monthIndex (0-11), colIdx }

  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    const monthHits = [];
    for (let c = 0; c < row.length; c++) {
      const cell = String(row[c] || '').toLowerCase().trim();
      const mIdx = MONTH_NAMES.indexOf(cell);
      const mIdxEn = MONTH_NAMES_EN.indexOf(cell);
      const found = mIdx >= 0 ? mIdx : mIdxEn >= 0 ? mIdxEn : -1;
      if (found >= 0) monthHits.push({ monthIndex: found, colIdx: c });
    }
    if (monthHits.length >= 6) { // mindst 6 måneder for at identificere header-rækken
      headerRowIdx = r;
      monthColIndices = monthHits;
      break;
    }
  }

  if (headerRowIdx < 0) {
    throw new Error('Kunne ikke finde måneds-overskrifter i Excel-filen. Forventede Jan-Dec i en række.');
  }
  console.log(`  Header-række fundet på linje ${headerRowIdx + 1}: ${monthColIndices.length} måneder identificeret`);

  // Kolonne B er index 1 (0-baseret)
  const CAT_COL = 1;

  const entries = [];
  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const rawName = row[CAT_COL];
    const catName = rawName ? String(rawName).trim() : '';
    if (isSkipRow(catName)) continue;

    for (const { monthIndex, colIdx } of monthColIndices) {
      const raw = row[colIdx];
      if (raw === null || raw === undefined || raw === '') continue;
      // Med raw:true er numeriske celler allerede tal; fallback til string-parsing
      let amount;
      if (typeof raw === 'number') {
        amount = raw;
      } else {
        // Håndter dansk format: "8.000,50" → 8000.50
        const cleaned = String(raw).replace(/\./g, '').replace(',', '.');
        amount = parseFloat(cleaned);
      }
      if (isNaN(amount)) continue;
      entries.push({ categoryName: catName, monthIndex, amountDKK: amount });
    }
  }

  return entries;
}

/**
 * Udled årstal fra filnavn (fx "Spiir Budget 2026.xlsx" → 2026).
 * Fallback: indeværende år.
 */
function yearFromFilename(filePath) {
  const m = path.basename(filePath).match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

/**
 * Actual Budget month string: "2026-01" (altid den 1. i måneden, nul-padded).
 */
function toActualMonth(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

// Actual API forventer beløb som heltal (øre)
function toActualAmount(dkk) {
  return Math.round(dkk * 100);
}

async function main() {
  console.log(`=== Spiir Excel Budget → Actual Budget ===`);
  console.log(`Fil:  ${path.basename(XLSX_FILE)}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (ingen ændringer)' : 'LIVE (opdaterer)'}\n`);

  // --- Indlæs kategori-mapping ---
  let mapping = {};
  if (fs.existsSync(MAPPING_FILE)) {
    mapping = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf-8'));
    console.log(`Kategori-mapping indlæst: ${Object.keys(mapping).length} aliaser\n`);
  } else {
    console.log(`Ingen budget-mapping.json fundet — bruger Excel-navne direkte\n`);
  }

  // --- Parser Excel ---
  console.log(`Læser Excel-fil...`);
  const entries = parseExcel(XLSX_FILE);
  console.log(`  ${entries.length} budgetposter fundet i Excel\n`);

  const year = yearFromFilename(XLSX_FILE);
  console.log(`Årstal detekteret: ${year}\n`);

  // Anvend mapping og summér beløb pr. (actualCategory, month)
  // Map: "actualCatName|monthKey" → sumDKK
  const budgetMap = new Map();
  for (const { categoryName, monthIndex, amountDKK } of entries) {
    const actualName = mapping[categoryName] || categoryName;
    const key = `${actualName}|||${toActualMonth(year, monthIndex)}`;
    budgetMap.set(key, (budgetMap.get(key) || 0) + amountDKK);
  }

  if (DRY_RUN) {
    console.log('--- DRY-RUN rapport ---');
    console.log('Følgende budgetbeløb ville blive sat:\n');
    for (const [key, dkk] of [...budgetMap].sort()) {
      const [catName, month] = key.split('|||');
      console.log(`  ${month}  ${catName.padEnd(40)} ${dkk.toFixed(2).padStart(10)} kr`);
    }
    console.log(`\nI alt: ${budgetMap.size} poster`);
    return;
  }

  // --- Forbind til Actual Budget ---
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Forbinder til Actual Budget...');
  await api.init({ dataDir: DATA_DIR, serverURL: SERVER_URL, password: PASSWORD });

  const budgets = await api.getBudgets();
  if (budgets.length === 0) throw new Error('Ingen budgetter på serveren');
  const budget = budgets[0];
  console.log(`Henter budget: ${budget.name}\n`);
  await api.downloadBudget(budget.groupId);

  // --- Byg kategori-lookup ---
  const groups = await api.getCategoryGroups();
  const categoryIdByName = new Map();
  for (const g of groups) {
    for (const c of (g.categories || [])) {
      categoryIdByName.set(c.name.toLowerCase(), c.id);
    }
  }

  // --- Sæt budgetbeløb ---
  let set = 0, skipped = 0;
  const notFound = new Set();

  console.log('Sætter budgetbeløb...');
  for (const [key, dkk] of budgetMap) {
    const [catName, month] = key.split('|||');
    const catId = categoryIdByName.get(catName.toLowerCase());
    if (!catId) {
      notFound.add(catName);
      skipped++;
      continue;
    }
    await api.setBudgetAmount(month, catId, toActualAmount(dkk));
    set++;
  }

  await api.sync();
  await api.shutdown();

  console.log(`\nFærdig!`);
  console.log(`  Sat:      ${set} budgetposter`);
  console.log(`  Sprunget: ${skipped} (kategori ikke fundet i Actual Budget)`);
  if (notFound.size > 0) {
    console.log(`\nKategorier der IKKE blev fundet (tilføj mapping i scripts/budget-mapping.json):`);
    for (const n of [...notFound].sort()) console.log(`  "${n}"`);
  }
}

main().catch(async err => {
  console.error('\nFejl:', err.message);
  console.error(err.stack);
  try { await api.shutdown(); } catch {}
  process.exit(1);
});
