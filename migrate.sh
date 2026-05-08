#!/usr/bin/env bash
# migrate.sh — Spiir til Actual Budget migrering (Mac/Linux)
# Kør med: bash migrate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"

echo ""
echo "===================================================="
echo "  Spiir til Actual Budget - Migreringsguide"
echo "===================================================="
echo ""
echo "Dette script flytter dine Spiir-data over i Actual Budget."
echo "Du kan til enhver tid afbryde med Ctrl+C."
echo ""

# --------------------------------------------------------
# Trin 1: Tjek Node.js
# --------------------------------------------------------
echo "[Trin 1/5] Tjekker Node.js..."
if ! command -v node &> /dev/null; then
    echo ""
    echo "  FEJL: Node.js er ikke installeret."
    echo ""
    echo "  Download Node.js gratis fra: https://nodejs.org/en/download"
    echo "  Vælg LTS-versionen og følg installationsguiden."
    echo ""
    echo "  Mac: Du kan også installere med Homebrew: brew install node"
    echo "  Ubuntu/Debian: sudo apt install nodejs npm"
    echo ""
    exit 1
fi
NODE_VER=$(node --version)
echo "  OK: Node.js $NODE_VER fundet."
echo ""

# --------------------------------------------------------
# Trin 2: Installér afhængigheder
# --------------------------------------------------------
echo "[Trin 2/5] Installerer programpakker..."
cd "$SCRIPT_DIR"
if [ ! -d "node_modules" ]; then
    echo "  Kører npm install (kun første gang)..."
    npm install
    echo "  Pakker installeret."
else
    echo "  Pakker allerede installeret."
fi
echo ""

# --------------------------------------------------------
# Trin 3: Konfiguration (URL + password)
# --------------------------------------------------------
echo "[Trin 3/5] Konfiguration af Actual Budget..."

if [ -f "$ENV_FILE" ]; then
    echo "  Fundet eksisterende .env — genbruger konfiguration."
    echo "  (Slet .env for at ændre indstillingerne)"
    # Udlæs URL til visning
    ACTUAL_SERVER_URL=$(grep "^ACTUAL_SERVER_URL=" "$ENV_FILE" | cut -d= -f2- | tr -d "'" '"')
    echo "  URL: $ACTUAL_SERVER_URL"
    echo "  Password: (skjult)"
else
    echo ""
    echo "  Actual Budget kan køre som Desktop App (ingen server) eller på en server."
    echo "  Desktop App: download fra https://actualbudget.org/download"
    echo "               start den, sæt et password, og brug URL: http://localhost:5006"
    echo ""
    read -r -p "  URL til Actual Budget [http://localhost:5006]: " ACTUAL_SERVER_URL
    if [ -z "$ACTUAL_SERVER_URL" ]; then
        ACTUAL_SERVER_URL="http://localhost:5006"
    fi

    echo ""
    read -r -s -p "  Password (det du satte i Actual Budget): " ACTUAL_PASSWORD
    echo ""
    if [ -z "$ACTUAL_PASSWORD" ]; then
        echo "  FEJL: Password må ikke være tomt."
        exit 1
    fi

    # Gem til .env
    {
        echo "ACTUAL_SERVER_URL=$ACTUAL_SERVER_URL"
        echo "ACTUAL_PASSWORD=$ACTUAL_PASSWORD"
    } > "$ENV_FILE"
    echo "  Konfiguration gemt i .env"
fi
echo ""

# --------------------------------------------------------
# Trin 4: Vælg CSV-fil
# --------------------------------------------------------
echo "[Trin 4/5] Vælg din Spiir CSV-eksport..."
echo ""
echo "  Har du ikke eksporteret endnu?"
echo "  1. Gå til spiir.dk og log ind"
echo "  2. Klik på dit navn øverst til højre"
echo "  3. Vælg 'Eksporter data' og hent CSV-filen"
echo ""
read -r -p "  Sti til CSV-fil (træk filen ind i terminalen): " CSV_FILE

# Fjern eventuelle anførselstegn
CSV_FILE="${CSV_FILE//\"/}"
CSV_FILE="${CSV_FILE//\'/}"
# Trim whitespace
CSV_FILE="$(echo "$CSV_FILE" | xargs)"

if [ -z "$CSV_FILE" ]; then
    echo "  FEJL: Ingen fil valgt."
    exit 1
fi
if [ ! -f "$CSV_FILE" ]; then
    echo "  FEJL: Filen blev ikke fundet: $CSV_FILE"
    exit 1
fi
echo "  Fil valgt: $CSV_FILE"
echo ""

# --------------------------------------------------------
# Trin 5: Kør migreringen
# --------------------------------------------------------
echo "[Trin 5/5] Starter migreringen..."
echo ""

echo "  Trin 5a: Opretter kategorier i Actual Budget..."
if ! node "$SCRIPT_DIR/scripts/initialize_budget.cjs" "$CSV_FILE"; then
    echo ""
    echo "  FEJL i initialize_budget. Se fejlbesked ovenfor."
    echo "  Mulige årsager:"
    echo "  - Actual Budget er ikke startet (åbn appen først)"
    echo "  - Forkert URL eller password i .env"
    echo "  - Slet .env og kør migrate.sh igen for at rette konfigurationen"
    exit 1
fi

echo ""
echo "  Trin 5b: Importerer transaktioner (10-20 minutter)..."
echo "  Luk IKKE dette vindue mens importen kører."
echo ""
if ! node "$SCRIPT_DIR/scripts/import_budget.cjs" "$CSV_FILE"; then
    echo ""
    echo "  FEJL i import_budget. Se fejlbesked ovenfor."
    exit 1
fi

echo ""
echo "===================================================="
echo "  Migration gennemført!"
echo ""
echo "  Åbn Actual Budget og tjek at transaktionerne"
echo "  er der og at saldiene stemmer."
echo ""
echo "  Vil du også importere dit Excel-budget?"
echo "  Kør: node scripts/sync_budget.cjs 'Spiir Budget 2026.xlsx'"
echo "===================================================="
echo ""
