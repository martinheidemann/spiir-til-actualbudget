@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1

echo.
echo ====================================================
echo   Spiir til Actual Budget - Migreringsguide
echo ====================================================
echo.
echo Dette program flytter dine Spiir-data over i Actual Budget.
echo Du kan til enhver tid lukke dette vindue med Ctrl+C.
echo.

:: --------------------------------------------------------
:: Trin 1: Tjek Node.js
:: --------------------------------------------------------
echo [Trin 1/5] Tjekker Node.js...
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo.
    echo   FEJL: Node.js er ikke installeret.
    echo.
    echo   Download Node.js gratis fra:
    echo   https://nodejs.org/en/download
    echo.
    echo   Vaelg "LTS"-versionen, klik Naeste hele vejen igennem,
    echo   og koen derefter denne fil igen.
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do set NODE_VER=%%v
echo   OK: Node.js %NODE_VER% fundet.
echo.

:: --------------------------------------------------------
:: Trin 2: Installer afhangigheder
:: --------------------------------------------------------
echo [Trin 2/5] Installerer programpakker...
if not exist "node_modules" (
    echo   Koerer npm install ^(kun foerste gang^)...
    npm install
    if !errorlevel! neq 0 (
        echo.
        echo   FEJL: npm install mislykkedes. Tjek at du er forbundet til internettet.
        pause
        exit /b 1
    )
    echo   Pakker installeret.
) else (
    echo   Pakker allerede installeret.
)
echo.

:: --------------------------------------------------------
:: Trin 3: Konfiguration (URL + password)
:: --------------------------------------------------------
echo [Trin 3/5] Konfiguration af Actual Budget...
set ENV_FILE=%~dp0.env

if exist "%ENV_FILE%" (
    echo   Fundet eksisterende .env - genbruger konfiguration.
    echo   ^(Slet .env for at aendre indstillingerne^)
    :: Laes eksisterende .env
    for /f "usebackq tokens=1,* delims==" %%a in ("%ENV_FILE%") do (
        set "line_key=%%a"
        set "line_val=%%b"
        if /i "!line_key!"=="ACTUAL_SERVER_URL" set "ACTUAL_SERVER_URL=!line_val!"
        if /i "!line_key!"=="ACTUAL_PASSWORD" set "ACTUAL_PASSWORD=!line_val!"
    )
    echo   URL:      !ACTUAL_SERVER_URL!
    echo   Password: ^(skjult^)
) else (
    echo.
    echo   Actual Budget kan koere som Desktop App ^(ingen server^) eller pa en server.
    echo   Desktop App: download fra https://actualbudget.org/download
    echo               start den, saet et password, og brug URL: http://localhost:5006
    echo.
    set /p "ACTUAL_SERVER_URL=  URL til Actual Budget [http://localhost:5006]: "
    if "!ACTUAL_SERVER_URL!"=="" set "ACTUAL_SERVER_URL=http://localhost:5006"

    echo.
    set /p "ACTUAL_PASSWORD=  Password (det du satte i Actual Budget): "
    if "!ACTUAL_PASSWORD!"=="" (
        echo   FEJL: Password maa ikke vaere tomt.
        pause
        exit /b 1
    )

    :: Gem til .env (fjern eventuelle anfoerselstegn fra input)
    set "CLEAN_URL=!ACTUAL_SERVER_URL:"=!"
    set "CLEAN_PASS=!ACTUAL_PASSWORD:"=!"
    (
        echo ACTUAL_SERVER_URL=!CLEAN_URL!
        echo ACTUAL_PASSWORD=!CLEAN_PASS!
    ) > "%ENV_FILE%"
    echo.
    echo   Konfiguration gemt i .env
)
echo.

:: --------------------------------------------------------
:: Trin 4: Vaelg CSV-fil
:: --------------------------------------------------------
echo [Trin 4/5] Vaelg din Spiir CSV-eksport...
echo.
echo   Har du ikke eksporteret endnu?
echo   1. Gaa til spiir.dk og log ind
echo   2. Klik pa dit navn oeverst til hoeire
echo   3. Vaelg "Eksporter data" og hent CSV-filen
echo.
echo   Traek CSV-filen ned i dette vindue, eller skriv stien manuelt:
set /p "CSV_FILE=  Sti til CSV-fil: "

:: Fjern anfoerselstegn hvis filen er traekket ind
set "CSV_FILE=!CSV_FILE:"=!"
:: Fjern evt. ledende/afsluttende mellemrum
for /f "tokens=* delims= " %%a in ("!CSV_FILE!") do set "CSV_FILE=%%a"

if "!CSV_FILE!"=="" (
    echo   FEJL: Ingen fil valgt.
    pause
    exit /b 1
)
if not exist "!CSV_FILE!" (
    echo   FEJL: Filen blev ikke fundet: !CSV_FILE!
    pause
    exit /b 1
)
echo   Fil valgt: !CSV_FILE!
echo.

:: --------------------------------------------------------
:: Trin 5: Koel migreringen
:: --------------------------------------------------------
echo [Trin 5/5] Starter migreringen...
echo.
echo   Trin 5a: Opretter kategorier i Actual Budget...
node "%~dp0scripts\initialize_budget.cjs" "!CSV_FILE!"
if !errorlevel! neq 0 (
    echo.
    echo   FEJL i initialize_budget. Se fejlbesked ovenfor.
    echo   Mulige aarsager:
    echo   - Actual Budget er ikke startet ^(aaben appen foerst^)
    echo   - Forkert URL eller password i .env
    echo   - Slet .env og koer migrate.bat igen for at rette konfigurationen
    pause
    exit /b 1
)

echo.
echo   Trin 5b: Importerer transaktioner (10-20 minutter)...
echo   Luk IKKE dette vindue mens importen koerer.
echo.
node "%~dp0scripts\import_budget.cjs" "!CSV_FILE!"
if !errorlevel! neq 0 (
    echo.
    echo   FEJL i import_budget. Se fejlbesked ovenfor.
    pause
    exit /b 1
)

echo.
echo ====================================================
echo   Transaktioner importeret!
echo ====================================================
echo.

:: --------------------------------------------------------
:: Trin 6 (valgfrit): Excel-budgetimport
:: --------------------------------------------------------
echo [Trin 6/6] Excel-budget (valgfrit)...
echo.
echo   Har du downloadet dine budgetfiler fra Spiir?
echo   (Spiir.dk ^> Eksporter ^> Eksporter budget for 2026/2027)
echo.
set /p "XLSX_2026=  Sti til 'Spiir Budget 2026.xlsx' (Enter = spring over): "
set "XLSX_2026=!XLSX_2026:"=!"

if not "!XLSX_2026!"=="" (
    if exist "!XLSX_2026!" (
        echo   Importerer budget for 2026...
        node "%~dp0scripts\sync_budget.cjs" "!XLSX_2026!"
    ) else (
        echo   Filen blev ikke fundet: !XLSX_2026!
    )
)

set /p "XLSX_2027=  Sti til 'Spiir Budget 2027.xlsx' (Enter = spring over): "
set "XLSX_2027=!XLSX_2027:"=!"

if not "!XLSX_2027!"=="" (
    if exist "!XLSX_2027!" (
        echo   Importerer budget for 2027...
        node "%~dp0scripts\sync_budget.cjs" "!XLSX_2027!"
    ) else (
        echo   Filen blev ikke fundet: !XLSX_2027!
    )
)

echo.
echo ====================================================
echo   Migration gennemfoert!
echo.
echo   Aaben Actual Budget og verificer at transaktioner
echo   og saldi stemmer.
echo ====================================================
echo.
pause
