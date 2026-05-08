# Spiir til Actual Budget

Spiir lukker den 8. juni 2026. Dette program hjælper dig med at flytte alle dine transaktioner og dit budget over i [Actual Budget](https://actualbudget.org/) — et gratis, open source alternativ.

**Du beholder:**
- Hele din transaktionshistorik (fra dag 1 i Spiir)
- Alle dine kategorier
- Dine budgetbeløb (fra Excel-eksport)

---

## Hvad skal du bruge?

| Program | Pris | Formål |
|---------|------|--------|
| [Actual Budget](https://actualbudget.org/download) | Gratis | Det nye budgetprogram |
| [Node.js LTS](https://nodejs.org/en/download) | Gratis | Kører dette migreringsscript |
| Spiir CSV-eksport | — | Dine data fra Spiir |

---

## Trin-for-trin guide

### Trin 1 — Installér Actual Budget

1. Gå til **https://actualbudget.org/download**
2. Download versionen til dit styresystem (Windows, Mac eller Linux)
3. Installér og start programmet
4. Opret et nyt tomt budget ("Create new file")
5. Sæt et password — **husk det, du skal bruge det i Trin 4**

> **Actual Budget kører lokalt på din computer** — dine data forlader ikke din maskine.
> Du behøver ikke betale for noget eller oprette en konto.

---

### Trin 2 — Eksportér dine data fra Spiir

1. Gå til **spiir.dk** og log ind
2. Klik på dit navn øverst til højre og vælg **"Eksportér data"**

**Transaktioner (påkrævet):**

3. Under **"Eksport af Poster"** → **"Avanceret eksport"**, klik **"Eksportér til CSV"**
   - Brug *Avanceret eksport* (ikke "Simpel eksport") — den indeholder alle metadata som kategorier, kontooverførsler og noter
   - Sæt start/slut dato hvis du kun vil have en del af historikken, ellers hentes alt

**Budget (valgfrit):**

4. Under **"Eksport af Budget"**, klik **"Eksportér budget for 2026"** og/eller **"Eksportér budget for 2027"**
   - Du kan sætte flueben i **"Inkludér forbrugsbudgetter"** hvis du vil have dem med
   - Disse Excel-filer bruges i Trin 5 til at importere budgetbeløb til Actual Budget

Gem alle filer et sted du nemt kan finde dem igen.

---

### Trin 3 — Installér Node.js

1. Gå til **https://nodejs.org/en/download**
2. Klik på den grønne **"LTS"**-knap (Long Term Support)
3. Kør installeringsprogrammet — klik **Næste** hele vejen igennem
4. Genstart computeren hvis installationen beder om det

Du behøver kun gøre dette én gang.

---

### Trin 4 — Kør migreringen

**Windows:**
1. Dobbeltklik på filen **`migrate.bat`** i denne mappe
2. Følg instruktionerne i det sorte vindue der åbner sig

**Mac: (IKKE TESTET)**
1. Åbn Terminal (søg efter "Terminal" i Spotlight)
2. Skriv `bash ` og træk derefter filen **`migrate.sh`** ind i Terminal-vinduet
3. Tryk Enter og følg instruktionerne

**Linux: (IKKE TESTET)**
1. Åbn en terminal i denne mappe
2. Kør: `bash migrate.sh`

Programmet spørger om:
- **URL til Actual Budget** — brug `http://localhost:5006` hvis du bruger Desktop App
- **Password** — det du satte i Trin 1
- **Stien til din Spiir CSV-fil** — fra Trin 2

Importen tager **5–20 minutter** afhængigt af antallet af konti og størrelsen af din transaktionshistorik. Luk ikke vinduet imens.

---

### Trin 5 (valgfrit) — Importér dit Excel-budget

Har du downloadet dit budget fra Spiir som Excel-fil? Du kan importere budgetbeløbene til Actual Budget:

```
node scripts/sync_budget.cjs "sti/til/Spiir Budget 2026.xlsx"
node scripts/sync_budget.cjs "sti/til/Spiir Budget 2027.xlsx"
```

**Test uden at ændre noget:**
```
node scripts/sync_budget.cjs "Spiir Budget 2026.xlsx" --dry-run
```

Scriptet vil fortælle dig hvilke Excel-kategorier det ikke fandt i Actual Budget. Du kan tilføje en mapping i `scripts/budget-mapping.json` — se eksempler i filen.

---

## Hvad gør programmet?

| Hvad | Detaljer |
|------|---------|
| Opretter kategorier | Alle dine Spiir-kategorier oprettes i Actual Budget |
| Importerer transaktioner | Alle poster fra alle dine konti |
| Overførsler | Interne overførsler mellem egne konti håndteres korrekt |
| Dubletcheck | Poster markeret "Ignorer" i Spiir håndteres intelligent - Spiir havde historisk et problem med dobbeltposter, som jeg håndterede ved at ignorere dubletter |
| Idempotent | Kan køres flere gange uden at dublere data |
| Additivt | Rører ikke eksisterende transaktioner fra andre banker - MEN... lav en backup af dit eksisterende Actual Budget inden spiir migrering |

---

## Kan jeg bruge det på et budget jeg allerede har data i?

Ja. Programmet er designet til at være **additivt** — det sletter aldrig noget eksisterende. Du kan trygt køre det på et budget der allerede har data fra en anden bank.

Alle Spiir-transaktioner får et unikt ID (`spiir:<id>`) så de ikke dublikeres hvis du kører importen igen.

---

## Filer i denne pakke

```
spiir-til-actual/
├── migrate.bat              ← Windows: dobbeltklik for at starte
├── migrate.sh               ← Mac/Linux: kør med "bash migrate.sh"
├── package.json             ← Programpakker (installeres automatisk)
├── .env.example             ← Skabelon til konfiguration
├── README.md                ← Denne vejledning
└── scripts/
    ├── initialize_budget.cjs  ← Opretter kategorier i Actual Budget
    ├── import_budget.cjs      ← Importerer transaktioner
    ├── sync_budget.cjs        ← Importerer Excel-budgetbeløb
    └── budget-mapping.json    ← Oversætter Excel-navne til Actual-navne
```

---

## Fejlfinding

**"Authentication failed: too-many-requests"**
Actual Budget blokerer for mange loginforsøg på én gang. Vent 5–10 minutter og prøv igen.

**"Ingen budgetter på serveren"**
Actual Budget er ikke startet, eller du har ikke oprettet et budget endnu. Åbn Actual Budget, opret et nyt tomt budget, og prøv igen.

**"CSV-fil ikke fundet"**
Tjek at stien til CSV-filen er korrekt. Prøv at trække filen direkte ind i terminalvinduet.

**Importen stopper med en fejl**
Scriptet er idempotent — du kan bare køre det igen. Det vil fortsætte fra der hvor det slap (kendte transaktioner springes over, nye tilføjes).

**Actual Budget viser en spinner og reagerer ikke**
Budgettet kan være kommet i en korrupt tilstand. Slet det i Actual Budget UI og opret et nyt tomt budget, og kør migreringen igen.

**Kategorier fra Excel matcher ikke**
Kør `sync_budget.cjs --dry-run` for at se hvilke navne der ikke matchede. Tilføj derefter en mapping i `scripts/budget-mapping.json`.

---

## Avanceret brug

### Manuel kørsel (uden wizard)

```powershell
# Windows PowerShell / Mac Terminal
node scripts/initialize_budget.cjs "min-spiir-eksport.csv"
node scripts/import_budget.cjs "min-spiir-eksport.csv"
node scripts/import_budget.cjs "min-spiir-eksport.csv" --dry-run  # test
```

### Selvhostet Actual Budget server

Ændre `.env` til at pege på din server:
```
ACTUAL_SERVER_URL=https://budget.ditdomaene.dk
ACTUAL_PASSWORD=dit-server-password
```

---

*Lavet til brug for alle Spiir-brugere der skal finde et nyt hjem til deres økonomi.*
