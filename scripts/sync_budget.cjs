/**
 * sync_budget.cjs
 *
 * Importerer budgetbeløb fra en Spiir Excel-budgetfil til Actual Budget.
 * Scriptet er ADDITIVT og IDEMPOTENT — kørsel sætter/overskriver kun de
 * måneds-/kategori-kombinationer der er nævnt i Excel-filen.
 *
 * Excel-struktur (Spiir Budget 2026/2027.xlsx):
 *   Øverst: et opsummerings-blok med totaler (ignoreres).
 *   Derefter tre sektioner adskilt af "divider-rækker" (kolonne A = sektionsnavn,
 *   måneds-kolonner indeholder etiketter "Jan"–"Dec" i stedet for tal):
 *
 *   Indkomst / Regninger-sektioner:
 *     Kolonne A = kategorinavn, kolonne B = brugernoter (ignoreres).
 *     Rækker med tom kolonne A summeres ind i den foregående kolonne-A-kategori.
 *
 *   Forbrug-sektion:
 *     Kolonne A = under-sektionsnavn (ignoreres), kolonne B = kategorinavn.
 *     Rækker med tom kolonne A bruger kolonne B som kategorinavn.
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
if (!SERVER_URL) { console.error('Mangler ACTUAL_SERVER_URL i .env.'); process.exit(1); }
if (!PASSWORD) { console.error('Mangler ACTUAL_PASSWORD i .env.'); process.exit(1); }

// --- Undertrykker @actual-app/api interne log-beskeder ---
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
async function quietly(fn) {
  console.log = () => {}; console.warn = () => {};
  try { return await fn(); } finally { console.log = _origLog; console.warn = _origWarn; }
}

// Månedsnavne (dansk og engelsk for robusthed)
const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'aug', 'sep', 'okt', 'nov', 'dec'];
const MONTH_NAMES_EN = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

// Rækker der er totaler/overskrifter og skal springes over
const SKIP_PATTERNS = [/ialt/i, /total/i, /^gns/i, /^årligt/i, /forbrugsloft/i];
function isSkipRow(name) {
  if (!name || !String(name).trim()) return true;
  return SKIP_PATTERNS.some(p => p.test(String(name).trim()));
}

function parseAmount(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'number') return raw;
  // Dansk format: "8.000,50" → 8000.50
  const cleaned = String(raw).replace(/\./g, '').replace(',', '.');
  const n = parseFloat(cleaned);
  return isNaN(n) ? null : n;
}

/**
 * Returnerer true hvis rækkens måneds-kolonner indeholder måneds-navne som strenge
 * (fx "Jan", "Feb") i stedet for tal. Bruges til at detektere sektion-genstart-rækker.
 */
function isMonthLabelRow(row, monthColIndices) {
  let labelCount = 0;
  for (const { colIdx } of monthColIndices) {
    const val = String(row[colIdx] || '').toLowerCase().trim();
    if (MONTH_NAMES.indexOf(val) >= 0 || MONTH_NAMES_EN.indexOf(val) >= 0) labelCount++;
  }
  return labelCount >= 6;
}

/**
 * Parser Excel og returnerer liste af { categoryName, monthIndex (0-11), amountDKK }.
 *
 * Excel-struktur har to typer sektioner:
 *   - Indkomst / Regninger: Kolonne A = kategorinavn, kolonne B = brugernoter (ignoreres)
 *   - Forbrug: Kolonne A = under-sektionsnavn (ignoreres), kolonne B = kategorinavn
 *
 * Sektioner markeres af rækker hvor kolonne A har et navn OG måneds-kolonnerne
 * indeholder måneds-etiketter ("Jan", "Feb" …) i stedet for tal.
 * Disse rækker springer vi over — de er kun dividers.
 *
 * Øverst i arket er der et opsummerings-blok (Indkomst, Regninger, Forbrug totaler)
 * som vi springer over ved hjælp af inDataSection-flaget.
 */
function parseExcel(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null, raw: true });

  // Find header-rækken med Jan-Dec
  let headerRowIdx = -1;
  let monthColIndices = []; // [{ monthIndex, colIdx }]
  for (let r = 0; r < rows.length; r++) {
    const hits = [];
    for (let c = 0; c < rows[r].length; c++) {
      const cell = String(rows[r][c] || '').toLowerCase().trim();
      const mDa = MONTH_NAMES.indexOf(cell);
      const mEn = MONTH_NAMES_EN.indexOf(cell);
      const found = mDa >= 0 ? mDa : mEn >= 0 ? mEn : -1;
      if (found >= 0) hits.push({ monthIndex: found, colIdx: c });
    }
    if (hits.length >= 6) { headerRowIdx = r; monthColIndices = hits; break; }
  }
  if (headerRowIdx < 0) throw new Error('Kunne ikke finde måneds-overskrifter i Excel-filen.');
  console.log(`  Header-række fundet på linje ${headerRowIdx + 1}: ${monthColIndices.length} måneder identificeret`);

  const entries = [];

  // Tilstand under scanning
  let inDataSection = false;   // false indtil første sektion-genstart-række ses
  let inForbrug = false;       // true inde i "Forbrug"-sektionen (bruger kolonne B som kategori)
  let currentGroupCat = null;  // Den aktuelle kolonne-A-kategori vi summerer ind i
  let groupUsesColA = false;   // true = tomme-A sub-rækker summeres i col A-kategori

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const rawA = row[0] != null ? String(row[0]).trim() : '';
    const rawB = row[1] != null ? String(row[1]).trim() : '';

    if (isSkipRow(rawA) && isSkipRow(rawB)) continue;

    // Detekter sektion-genstart-rækker: kolonne A har navn OG måneds-kolonner har måneds-etiketter.
    // Eksempel: "Indkomst" (Jan Feb … Dec), "Regninger" (Jan Feb … Dec), "Forbrug" (Jan Feb … Dec).
    // Disse rækker er kun dividers — vi springer dem over men opdaterer tilstand.
    if (rawA && !isSkipRow(rawA) && isMonthLabelRow(row, monthColIndices)) {
      inDataSection = true;
      currentGroupCat = rawA;
      groupUsesColA = false;
      inForbrug = rawA.toLowerCase() === 'forbrug';
      continue;
    }

    // Spring summarieringsrækker over der optræder inden første sektions-divider
    if (!inDataSection) continue;

    // Træk beløb ud for alle måneds-kolonner
    const monthAmounts = [];
    for (const { monthIndex, colIdx } of monthColIndices) {
      const amt = parseAmount(row[colIdx]);
      if (amt != null && amt !== 0) monthAmounts.push({ monthIndex, amountDKK: amt });
    }
    const hasAmounts = monthAmounts.length > 0;

    if (rawA && !isSkipRow(rawA)) {
      currentGroupCat = rawA;
      if (hasAmounts) {
        if (inForbrug && rawB && !isSkipRow(rawB)) {
          // Forbrug-sektion: kolonne A er under-sektionsnavn, kolonne B er den egentlige kategori
          for (const m of monthAmounts) entries.push({ categoryName: rawB, ...m });
          // groupUsesColA forbliver false — efterfølgende tomme-A rækker bruger col B
        } else {
          // Indkomst / Regninger: kolonne A er kategorien
          groupUsesColA = true;
          for (const m of monthAmounts) entries.push({ categoryName: rawA, ...m });
        }
      } else {
        // Ingen beløb → under-sektionsoverskrift (fx "Bolig" inden i Regninger)
        groupUsesColA = false;
      }
    } else if (!rawA && rawB && !isSkipRow(rawB)) {
      if (inForbrug) {
        // Forbrug-sektion: kolonne B er kategorien
        for (const m of monthAmounts) entries.push({ categoryName: rawB, ...m });
      } else {
        // Uden for Forbrug: summér ind i kolonne-A-gruppe
        const catName = groupUsesColA ? currentGroupCat : rawB;
        if (catName) {
          for (const m of monthAmounts) entries.push({ categoryName: catName, ...m });
        }
      }
    }
  }

  return entries;
}

/**
 * Udled årstal fra filnavn (fx "Spiir Budget 2026.xlsx" → 2026).
 */
function yearFromFilename(filePath) {
  const m = path.basename(filePath).match(/\b(20\d{2})\b/);
  return m ? parseInt(m[1], 10) : new Date().getFullYear();
}

/** Actual Budget month string: "2026-01" */
function toActualMonth(year, monthIndex) {
  return `${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

function toActualAmount(dkk) {
  return Math.round(dkk * 100);
}

async function main() {
  console.log(`=== Spiir Excel Budget → Actual Budget ===`);
  console.log(`Fil:  ${path.basename(XLSX_FILE)}`);
  console.log(`Mode: ${DRY_RUN ? 'DRY-RUN (ingen ændringer)' : 'LIVE (opdaterer)'}\n`);

  // --- Parser Excel ---
  console.log(`Læser Excel-fil...`);
  const entries = parseExcel(XLSX_FILE);
  console.log(`  ${entries.length} budgetposter fundet i Excel\n`);

  const year = yearFromFilename(XLSX_FILE);
  console.log(`Årstal detekteret: ${year}\n`);

  // --- Indlæs budget-mapping.json (valgfrit) ---
  const MAPPING_FILE = path.join(__dirname, 'budget-mapping.json');
  let mappingLower = new Map();
  if (fs.existsSync(MAPPING_FILE)) {
    const raw = JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
    mappingLower = new Map(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
    if (mappingLower.size > 0) console.log(`Mapping-fil: ${mappingLower.size} aliaser indlæst\n`);
  }

  // Summér beløb pr. (kategori, måned) — anvend evt. mapping
  const budgetMap = new Map(); // "resolvedCatName|||month" → sumDKK
  for (const { categoryName, monthIndex, amountDKK } of entries) {
    const resolvedName = mappingLower.get(categoryName.toLowerCase()) || categoryName;
    const key = `${resolvedName}|||${toActualMonth(year, monthIndex)}`;
    budgetMap.set(key, (budgetMap.get(key) || 0) + amountDKK);
  }

  // --- Forbind til Actual Budget ---
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  console.log('Forbinder til Actual Budget...');
  await quietly(() => api.init({ dataDir: DATA_DIR, serverURL: SERVER_URL, password: PASSWORD }));

  const budgets = await quietly(() => api.getBudgets());
  if (budgets.length === 0) throw new Error('Ingen budgetter på serveren');
  const budget = budgets[0];
  console.log(`Henter budget: ${budget.name}\n`);
  await quietly(() => api.downloadBudget(budget.groupId));

  // --- Byg kategori-lookup ---
  const groups = await quietly(() => api.getCategoryGroups());
  const categoryIdByName = new Map();
  for (const g of groups) {
    for (const c of (g.categories || [])) {
      categoryIdByName.set(c.name.toLowerCase(), c.id);
    }
  }

  if (DRY_RUN) {
    console.log('--- DRY-RUN rapport ---');
    console.log('Følgende budgetbeløb ville blive sat:\n');
    const notFound = new Set();
    for (const [key, dkk] of [...budgetMap].sort()) {
      const [catName, month] = key.split('|||');
      const found = categoryIdByName.has(catName.toLowerCase());
      if (!found) { notFound.add(catName); continue; }
      console.log(`  ${month}  ${catName.padEnd(40)} ${dkk.toFixed(2).padStart(10)} kr`);
    }
    console.log(`\nI alt: ${budgetMap.size - notFound.size} poster ville blive sat`);
    if (notFound.size > 0) {
      console.log(`\nKategorier der IKKE findes i Actual Budget (tilføj til budget-mapping.json):`);
      for (const n of [...notFound].sort()) console.log(`  "${n}"`);
    }
    await quietly(() => api.shutdown());
    return;
  }

  // --- Sæt budgetbeløb ---
  let set = 0, skipped = 0;
  const notFound = new Set();

  console.log('Sætter budgetbeløb...');
  for (const [key, dkk] of budgetMap) {
    const [catName, month] = key.split('|||');
    const catId = categoryIdByName.get(catName.toLowerCase());
    if (!catId) { notFound.add(catName); skipped++; continue; }
    await quietly(() => api.setBudgetAmount(month, catId, toActualAmount(dkk)));
    set++;
  }

  await quietly(() => api.sync());
  await quietly(() => api.shutdown());

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
  try { await quietly(() => api.shutdown()); } catch {}
  process.exit(1);
});
