/**
 * _load-env.cjs
 *
 * Indlæser miljøvariabler fra .env i pakkens rodmappe (en mappe op fra scripts/).
 * Kald via require() øverst i et script:
 *
 *   require('./_load-env.cjs');
 *
 * Eksisterende process.env-værdier overskrives ikke.
 */
const fs = require('fs');
const path = require('path');

function loadEnv() {
  // .env ligger i rodmappen (én mappe op fra scripts/)
  const envPath = path.resolve(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, 'utf-8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    // Fjern omsluttende quotes hvis de findes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = val;
  }
}

loadEnv();
