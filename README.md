# Spiir til Actual Budget

Spiir lukker den 8. juni 2026. Dette program hjælper dig med at flytte alle dine transaktioner og dit budget over i [Actual Budget](https://actualbudget.org/) — et gratis, open source alternativ.

**Du beholder:**

- Hele din transaktionshistorik (fra dag 1 i Spiir)
- Alle dine kategorier
- Dine budgetbeløb (fra Excel-eksport)

---

## Om dette projekt

Jeg hedder Martin, er 46 år og arbejder som udvikler ved JP/Politikens Hus. Jeg har brugt Spiir siden 2010 og er rigtig glad for det overblik det har givet mig over min økonomi gennem årene.

Da Spiir annoncerede lukning begyndte jeg at kigge efter alternativer og faldt over [Actual Budget](https://actualbudget.org/) — et open source projekt der ser rigtig fornuftigt ud. Jeg kører selv Actual Budget **self-hosted** på en hjemmeserver, men der er mange muligheder:

- **Lokalt** — installer Desktop App på din computer, ingen server nødvendig
- **Self-hosted** — kør det på din egen server (Docker, LXC m.m.)
- **Hosted** — betal for en managed løsning hos fx [PikaPods](https://www.pikapods.com/)

Jeg har skiftet Actual Budget til at køre **transaktionelt** i stedet for envelope-baseret — det gøres under Indstillinger i Actual Budget og passer bedre til den måde jeg tænker økonomi på.

Dette er et **hobbyprojekt** som jeg primært har lavet til mig selv, men med håb om at det kan være nyttigt for andre Spiir-brugere. Jeg har testet det på **Windows** og **Linux (WSL)**, men ikke alle scenarier — så der kan sagtens være særlige situationer jeg ikke har stødt på. Prøv gerne et par gange og tjek fejlfindingssektionen nedenfor hvis noget driller. Er du stadig sidder fast, er du velkommen til at skrive til mig på **[martinheide+actual@gmail.com](mailto:martinheide+actual@gmail.com)** — ingen garantier for svartid, men jeg hjælper gerne.

### Automatisk bankintegration

Jeg er ikke selv kommet dertil endnu, men det er muligt at forbinde Actual Budget direkte til din bank via:

- **[Lunchflow](https://www.lunchflow.app/coverage)** — tjek om din bank er understøttet
- **[EnableBanking](https://enablebanking.com/)** — europæisk løsning

Disse løsninger giver automatisk import af nye transaktioner fra din bank. Det må I selv researche — opsætning af konti og bankintegration er ikke dækket af dette projekt.

---

## Hvad skal du bruge?

| Program                                            | Pris   | Formål                       |
| -------------------------------------------------- | ------ | ---------------------------- |
| [Actual Budget](https://actualbudget.org/download) | Gratis | Det nye budgetprogram        |
| [Node.js LTS](https://nodejs.org/en/download)      | Gratis | Kører dette migreringsscript |
| Spiir CSV-eksport                                  | —      | Dine data fra Spiir          |

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
   - Brug _Avanceret eksport_ (ikke "Simpel eksport") — den indeholder alle metadata som kategorier, kontooverførsler og noter
   - Sæt start/slut dato hvis du kun vil have en del af historikken, ellers hentes alt

**Budget (valgfrit):**

4. Under **"Eksport af Budget"**, klik **"Eksportér budget for 2026"** og/eller **"Eksportér budget for 2027"**
   - Du kan sætte flueben i **"Inkludér forbrugsbudgetter"** hvis du vil have dem med
   - Disse Excel-filer bruges i Trin 5 til at importere budgetbeløb til Actual Budget

Gem alle filer et sted du nemt kan finde dem igen.

---

### Trin 3 — Hent dette program

1. Gå til **https://github.com/martinheidemann/spiir-til-actualbudget/releases/latest**
2. Under **"Assets"**, klik på **`Source code (zip)`**
3. Pak ZIP-filen ud et sted du nemt kan finde den igen — fx på Skrivebordet eller i Dokumenter
4. Du får en mappe der hedder noget i stil med `spiir-til-actualbudget-1.0.0`

---

### Trin 4 — Installér Node.js

1. Gå til **https://nodejs.org/en/download**
2. Klik på den grønne **"LTS"**-knap (Long Term Support)
3. Kør installeringsprogrammet — klik **Næste** hele vejen igennem
4. Genstart computeren hvis installationen beder om det

Du behøver kun gøre dette én gang.

---

### Trin 5 — Kør migreringen

**Windows:**

1. Dobbeltklik på filen **`migrate.bat`** i denne mappe
2. Følg instruktionerne i det sorte vindue der åbner sig

**Mac: (ikke testet)**

1. Åbn Terminal (søg efter "Terminal" i Spotlight)
2. Skriv `bash ` og træk derefter filen **`migrate.sh`** ind i Terminal-vinduet
3. Tryk Enter og følg instruktionerne

**Linux / WSL:**

1. Åbn en terminal i denne mappe
2. Kør: `bash migrate.sh`

> **WSL-brugere:** Sørg for at `npm install` er kørt inde fra WSL-terminalen, ikke fra Windows — native Node.js-moduler skal kompileres til det rigtige OS.

Guiden tager dig igennem hele migreringen i ét hug og spørger om følgende — tryk bare Enter for at springe et trin over:

1. **URL til Actual Budget** — brug `http://localhost:5006` hvis du bruger Desktop App
2. **Password** — det du satte i Trin 1
3. **Sti til Spiir CSV-filen** — fra Trin 2. Importerer kategorier og transaktioner (5–20 min — luk ikke vinduet)
4. **Sti til `Spiir Budget 2026.xlsx`** — valgfrit, importerer budgetbeløb for 2026
5. **Sti til `Spiir Budget 2027.xlsx`** — valgfrit, importerer budgetbeløb for 2027

Du kan trække filer direkte ind i terminalvinduet i stedet for at skrive stien.

---

## Hvad gør programmet?

| Hvad                     | Detaljer                                                                                                                                                   |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opretter kategorier      | Alle dine Spiir-kategorier oprettes i Actual Budget                                                                                                        |
| Importerer transaktioner | Alle poster fra alle dine konti                                                                                                                            |
| Overførsler              | Interne overførsler mellem egne konti håndteres korrekt                                                                                                    |
| Dubletcheck              | Poster markeret "Ignorer" i Spiir håndteres intelligent - Spiir havde historisk et problem med dobbeltposter, som jeg håndterede ved at ignorere dubletter |
| Idempotent               | Kan køres flere gange uden at dublere data                                                                                                                 |
| Additivt                 | Rører ikke eksisterende transaktioner fra andre banker — lav en backup af dit eksisterende Actual Budget inden Spiir-migrering                             |

---

## Kan jeg bruge det på et budget jeg allerede har data i?

Ja. Programmet er designet til at være **additivt** — det sletter aldrig noget eksisterende. Du kan trygt køre det på et budget der allerede har data fra en anden bank.

Alle Spiir-transaktioner gemmes med et unikt ID, så de ikke importeres to gange — selv hvis du kører scriptet igen.

> **Tip:** Lav en backup af dit Actual Budget inden du kører migreringen — enten via Actual Budgets egen export-funktion eller ved at kopiere data-mappen.

---

## Hvad gør jeg hvis saldoen ikke passer med banken?

Når importen er færdig kan du sammenligne dine kontosaldi i Actual Budget med dem i din netbank. I de fleste tilfælde matcher de præcist — men på konti med mange års historik kan der opstå små eller mellemstore afvigelser. Det er sjældent en fejl i programmet; det er typisk fordi Spiir-eksporten ikke er et 100 % korrekt billede af bankens historik.

### Hvorfor kan Spiir-data være ufuldstændige?

Spiir har eksisteret siden 2009 og synkroniserer med danske banker via skiftende grænseflader. Igennem 15+ år har det betydet:

- **Manglende synkroniseringer.** Hvis Spiir i en periode ikke kunne forbinde til banken (vedligehold, ændrede API'er, login-problemer), kan enkelte dage eller uger mangle. Banken har transaktionerne, men de er aldrig nået ind i Spiir.
- **CSV-formatet er blevet bedre over tid.** Nyere overførsler mellem dine egne konti er korrekt forbundne i CSV'en, men for ældre data — særligt fra 2010-erne — mangler forbindelsen på en del overførsler. Programmet forsøger at genfinde disse ved at matche på beskrivelse, dato og beløb i en ekstra gennemgang, og opretter selv den manglende modpostering når kun den ene side findes. Er begge sider helt væk, kan vi ikke gætte os til dem.

- **Duplikater og fejlimporter.** Enkelte datoer har Spiir nogle gange importeret de samme bankposteringer to gange — undertiden med korrupte saldoværdier. Programmet detekterer og frasorterer disse, men hvis dubletten har lidt anderledes felter end originalen, kan en enkelt postering slippe igennem og påvirke saldoen.

- **Bankoverførsler til konti uden for Spiir.** Pengeoverførsler til en realkreditkonto, en konto hos en anden bank, eller en gammel lukket konto er reelle pengebevægelser, men kan ikke verificeres mod en modpart i CSV'en. Programmet importerer dem som almindelige posteringer med kategorien "Ignoreret".

### Slutsaldoen er garanteret korrekt — men kun for én dato

Programmet beregner åbningssaldoen *baglæns* ud fra slutsaldoen i CSV'en og alle de posteringer der faktisk importeres. Det betyder:

- **Slutsaldoen på CSV-eksportdagen** vil matche banken præcist.
- **Den nuværende bankbalance** kan godt afvige, simpelthen fordi der er sket noget på kontoen efter du eksporterede.
- **Historisk saldo undervejs** kan afvige hvis der mangler posteringer. Programmet udskriver hvilke konti og fra hvilken dato det gælder.

Sammenlign altid med slutsaldoen **fra den dag du eksporterede CSV'en** — ikke med dagens bank-app. Hvis du vil have det 100 % opdateret, eksportér en frisk CSV og kør importen igen (du kan køre det igen uden problemer — transaktioner importeres aldrig to gange).

### Når slutsaldoen alligevel ikke matcher

Hvis slutsaldoen ikke matcher, er årsagen typisk én af:

1. **En manglende synkronisering i Spiir.** En transaktion banken kender, men Spiir aldrig fik. Den eneste rigtige løsning er at tilføje den manuelt i Actual Budget — eller justere åbningssaldoen så slutsaldoen passer (se næste sektion).
2. **En duplikat der ikke blev fanget.** Hvis to næsten identiske posteringer slap igennem som forskellige, vil saldoen være højere/lavere end den burde. Find duplikatet i Actual Budget og slet det.
3. **En overførsel der blev importeret som almindelig postering** fordi modparten manglede og beskrivelsen ikke nævnte en kendt konto. Det giver korrekt slutsaldo, men kontoen får posten under "Ignoreret" i stedet for som overførsel.

---

## Sådan retter du åbningssaldoen manuelt

Hvis slutsaldoen i Actual Budget afviger fra banken med et fast beløb, kan du justere åbningssaldoen direkte. Det er en simpel "plus eller minus"-regning og kræver ingen genimport.

### Trin 1 — Find afvigelsen

For hver konto der ikke matcher, regn forskellen ud:

```
Afvigelse = bank − Actual Budget
```

Hvis tallet er **positivt** mangler Actual Budget penge — du skal *øge* åbningssaldoen med det beløb.
Hvis tallet er **negativt** har Actual Budget for mange penge — du skal *sænke* åbningssaldoen med det beløb.

### Trin 2 — Find åbningssaldo-transaktionen i Actual Budget

1. Åbn Actual Budget og klik på kontoen i sidebaren
2. Scroll helt til bunden af transaktionslisten (eller sortér efter dato — ældste først)
3. Den allerførste transaktion er typisk en med teksten **"Starting Balance"** eller **"Åbningssaldo"** og payee "Starting Balance"

### Trin 3 — Ret beløbet

1. Klik på Starting Balance-transaktionens beløb
2. Læg afvigelsen til (eller træk fra) det eksisterende beløb:

   ```
   Ny åbningssaldo = gammel åbningssaldo + afvigelse
   ```

3. Gem (tryk Enter eller klik væk fra feltet)
4. Slutsaldoen i sidebaren bør nu matche banken præcist

### Hurtig-formel

```
┌──────────────────────────────────────────────────────────┐
│  ny åbningssaldo = gammel åbningssaldo + (bank − Actual) │
└──────────────────────────────────────────────────────────┘
```

Det virker for alle konti uanset om åbningssaldoen er positiv eller negativ — du lægger bare differencen til.

### Hvorfor virker det?

I Actual Budget er en kontos saldo simpelthen: åbningssaldo + summen af alle transaktioner. Hvis transaktionerne er korrekte men slutsaldoen mangler et beløb X, så mangler X i åbningssaldoen. Du justerer ét sted, og hele saldohistorikken flytter sig X.

> **OBS:** Hvis afvigelsen ER fordi der mangler en transaktion (ikke fordi åbningssaldoen er forkert), så får du det rigtige *slutbeløb* ved at justere åbningssaldoen — men dine historiske grafer i den manglende periode vil stadig se underlige ud. Vil du have det "rent" må du tilføje den manglende transaktion manuelt på den rigtige dato.

### Vil du have ren historik fra start? Begræns eksporten

Hvis du oplever mange afvigelser kan det give et pænere resultat at starte fra et tidspunkt hvor dine data er mere komplette. For mange brugere vil de seneste 3–5 år være fuldt dækkede og uden problemer.

**Sådan begrænser du eksporten i Spiir:**

1. Gå til **spiir.dk → Eksportér data → Avanceret eksport**
2. Sæt en **startdato** — fx 1. januar 2020 eller 1. januar 2022
3. Eksportér CSV-filen og brug den i stedet

Åbningssaldoen justeres automatisk så slutsaldoen stadig passer, uanset hvilken startdato du vælger.

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
    └── sync_budget.cjs        ← Importerer Excel-budgetbeløb
```

---

## Fejlfinding

**Fejl under "Installerer programpakker" (npm install)**
Det kan ske at npm ikke kan hente alle pakker første gang — typisk pga. netværk eller en midlertidig fejl. Luk vinduet og dobbeltklik på `migrate.bat` igen. Scriptet prøver automatisk at installere pakkerne forfra.

**"Authentication failed: too-many-requests"**
Actual Budget blokerer for mange loginforsøg på én gang. Vent 5–10 minutter og prøv igen.

**"Ingen budgetter på serveren"**
Actual Budget er ikke startet, eller du har ikke oprettet et budget endnu. Åbn Actual Budget, opret et nyt tomt budget, og prøv igen.

**"CSV-fil ikke fundet"**
Tjek at stien til CSV-filen er korrekt. Prøv at trække filen direkte ind i terminalvinduet.

**Importen stopper med en fejl**
Scriptet husker hvilke transaktioner det allerede har importeret — du kan bare køre det igen. Det vil fortsætte fra der hvor det slap (kendte transaktioner springes over, nye tilføjes).

**Actual Budget viser en spinner og reagerer ikke**
Budgettet kan være kommet i en korrupt tilstand. Slet det i Actual Budget UI og opret et nyt tomt budget, og kør migreringen igen.

**Saldi passer ikke efter en ny import (slettet og startet forfra)**
Scriptet gemmer en lokal kopi af budgettet i mappen `.actual-data`. Hvis du sletter budgettet i Actual Budget UI og importerer igen, kan den gamle cache give forkerte resultater. Slet mappen `.actual-data` i programmets mappe og kør migreringen igen — den oprettes automatisk på ny.

**Noget andet driller?**
Prøv et par gange og tjek fejlbeskeden grundigt. Virker det stadig ikke, er du velkommen til at skrive til **[martinheide+actual@gmail.com](mailto:martinheide+actual@gmail.com)**. Ingen garantier for svartid, men jeg hjælper gerne.

---

## Avanceret brug

### Manuel kørsel (uden guide)

```powershell
# Importér kategorier og transaktioner fra CSV
node scripts/initialize_budget.cjs "min-spiir-eksport.csv"
node scripts/import_budget.cjs "min-spiir-eksport.csv"
node scripts/import_budget.cjs "min-spiir-eksport.csv" --dry-run  # test uden ændringer

# Importér budgetbeløb fra Excel
node scripts/sync_budget.cjs "Spiir Budget 2026.xlsx"
node scripts/sync_budget.cjs "Spiir Budget 2026.xlsx" --dry-run   # test uden ændringer
```

### Selvhostet Actual Budget server

Ændre `.env` til at pege på din server:

```
ACTUAL_SERVER_URL=https://budget.ditdomaene.dk
ACTUAL_PASSWORD=dit-server-password
```

---

_Lavet af Martin Heidemann — Spiir-bruger siden 2010. Hobbyprojekt lavet til mig selv, med håb om at det kan bruges af andre. Testet på Windows og Linux (WSL). Spørgsmål: [martinheide+actual@gmail.com](mailto:martinheide+actual@gmail.com)_

---

## Om koden

Scriptsene i dette projekt er i stor stil bygget ved hjælp af [Claude Code](https://claude.ai/download) — Anthropics AI-kodningsassistent. Claude Code har hjulpet med alt fra den indledende arkitektur og Excel-parsing til fejlretning og iterativ forfining af logikken.

Har du selv lyst til at tilpasse eller udvide scriptsene, kan Claude Code være en god hjælp — også selvom du ikke er udvikler til daglig.
