# Angebotsradar

Android-App, die Supermarkt-Angebote im Umkreis zeigt: Produktsuche, einstellbarer Radius, Händler und Restlaufzeit je Angebot, Route per Google Maps und Benachrichtigung, sobald ein beobachtetes Produkt (Standard: Monster Ultra White) im Angebot ist.

- `src/` – App (HTML/CSS/JS); `src/lib.js` ist die gemeinsame Logik für App und Hintergrund-Task
- `runners/offers.js` – Hintergrund-Task, prüft etwa stündlich die Beobachtungsliste
- `build-web.js` – baut `www/` für Android
- `android/` – Capacitor-Android-Projekt
- `.github/workflows/apk.yml` – baut bei jedem Push auf `main` die APK und veröffentlicht sie als Release

Datenquellen: Angebote aus den öffentlichen Suchseiten von marktguru und kaufDA (`SOURCES` in `src/lib.js`), Märkte und Adressen aus OpenStreetMap (Overpass, Nominatim).

Tests: `npm test`
