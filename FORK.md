# Fork-Abweichungen — Tarkov Stammtisch Daten-Overlay

Privater Fork von [tarkovtracker-org/tarkov-data-overlay](https://github.com/tarkovtracker-org/tarkov-data-overlay) (**MIT**). Stand: Branch `sync/upstream-2026-11-21`, Upstream `main` = Version 1.184. Diese Datei wurde gegen `git diff --name-status upstream/main HEAD` abgeglichen.

> ⚠️ **Namensverwirrung:** „Overlay" bedeutet bei uns drei Dinge.
> Dieses Repo ist das **Spieldaten-Overlay**: Korrekturen an den Quest-/Item-Daten von tarkov.dev, reines JSON ohne Darstellung.
> Nicht zu verwechseln mit dem **Theme** des Trackers (Farben, im App-Fork in `tailwind.css`/`app.config.ts`) und nicht mit den **OBS-Overlays** für Streams auf der Hauptseite.

Zugehörig: App-Fork [`miwidot/stammtisch-tracker`](https://github.com/miwidot/stammtisch-tracker) (eigene `FORK.md`, dort steht auch, wie der App-Server `OVERLAY_URL` liest) · Epic [#1293](https://github.com/miwidot/tarkov-stammtisch/issues/1293)

---

## Worum es geht

Der Tracker unterstützt **genau eine** Overlay-Quelle. Zeigt `OVERLAY_URL` auf eine eigene Datei, ist das Upstream-Overlay komplett weg, inklusive aller Korrekturen. Deshalb betreiben wir dieses Repo als Fork, der Upstream laufend einmerged, und bauen **eine** Datei aus Upstreams Stand.

**Unsere deutschen Übersetzungen (`src/overrides/locales/de.json5`) sind seit den Upstream-PRs #280/#281 bei Upstream.** Dieser Fork trägt keine Daten- oder Übersetzungsänderungen mehr: `src/` und `dist/` sind identisch mit Upstream (`git diff upstream/main HEAD -- src dist` ist leer). Der Fork existiert heute wegen des **Katalog-Erzeugers** (unten) und weil Server und Cron aus unserem eigenen Remote arbeiten.

---

## Was noch abweicht

Gemessen mit `git diff --name-status upstream/main HEAD`: 19 Dateien, alle hinzugefügt außer zwei.

### Gelöscht

| Datei                    | Handgriff beim Merge                                              |
| ------------------------ | ----------------------------------------------------------------- |
| `.github/dependabot.yml` | Konflikt „deleted in HEAD": `git rm .github/dependabot.yml`       |

Kein Dependabot-Versions-Update im privaten Fork.

### Geändert

| Datei          | Was                                                                                                                      |
| -------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `package.json` | zwei Zeilen unter `scripts`: `build:catalogs` und `parity` (Konfliktrisiko gering, nur bei Änderungen direkt daneben)     |

### Neu (kosten beim Merge nichts)

| Datei                                                                                                                         | Zweck                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `FORK.md`                                                                                                                     | dieses Dokument                                                                                             |
| `scripts/build-catalogs.ts`                                                                                                   | Erzeuger: Overlay bauen, Tracker-Produzent laufen lassen, Kataloge atomar veröffentlichen                   |
| `scripts/producer/lib.ts`, `tracker.ts`, `https-server.ts`, `process.ts`, `tracker.lock.json`                                 | Bausteine dazu und der Pin auf den Tracker-Commit                                                           |
| `scripts/producer/cron-run.sh`, `scripts/producer/prune-tools.ts`                                                             | Cron-Wrapper mit Discord-Alarm; optionales Aufräumen alter Tracker-Checkouts                                |
| `scripts/parity.ts`, `scripts/parity/{catalogs,compare,normalize}.ts`                                                         | Paritätsprüfung gegen tarkovtracker.org                                                                     |
| `tests/producer-lib.test.ts`, `producer-cron.test.ts`, `build-catalogs.test.ts`, `parity-normalize.test.ts`                   | Tests dazu                                                                                                  |

### Nicht im Code, sondern in den GitHub-Einstellungen des Forks

- Workflow **„Release overlay" ist deaktiviert** (`disabled_manually`). Upstreams `release.yml` committet, taggt und pusht `dist/` nach jedem erfolgreichen CI-Lauf auf `main`; bei uns wäre das eine zweite Historie für ein Artefakt. Die Datei selbst ist unverändert (kein Merge-Konflikt). Nicht wieder einschalten.
- Aktiv: CI, Annual license year update, Dependabot Updates.

---

## Remotes

| Remote     | URL                                                  | Regel                                                                                  |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `origin`   | `git@github.com:miwidot/stammtisch-tracker-overlay.git` | Unser Fork. Hierhin pushen, Server und Cron holen von hier                          |
| `mirror`   | `git@github.com:MiwiDots/tarkov-data-overlay.git`       | Öffentlicher Fork, **nur** für Pull Requests an Upstream                            |
| `upstream` | `https://github.com/tarkovtracker-org/tarkov-data-overlay.git` | **Nie pushen** ohne ausdrückliche Rückfrage                                   |

Vor jedem Push `git remote get-url origin` prüfen.

---

## Tags und Version

Die Overlay-Version ist die **höchste Tag-Version `v*`, die in `HEAD` enthalten ist** (`git tag --merged HEAD --list 'v*'`, aktuell `v1.184`). Fehlen Upstream-Tags, baut ein frischer Klon oder der Server eine viel zu niedrige Version (so geschehen: 1.67 statt 1.184).

- **`v1.0` bis `v1.7` zeigen jetzt auf Upstreams Commits** (alle liegen in `upstream/main`). Früher zeigten sie bei uns auf andere Commits (Altlast aus August 2026) und blockierten `git push --tags`.
- **Unsere alten August-Tags sind erhalten** als `fork-2026-08/v1.0` bis `fork-2026-08/v1.7` (lokal und auf `origin`). `--merged HEAD --list 'v*'` zählt sie nicht mit, weil sie nicht mit `v` beginnen.
- Beim Merge deshalb immer `git push origin --tags`; das lehnt jetzt keine Tags mehr ab. Nie mit `--force` überschreiben, ohne zu klären, welche Fassung gelten soll.
- Wer mitten in einem noch nicht abgeschlossenen Merge baut, bekommt die alte Version: erst den Merge committen, dann bauen.

---

## `dist/` fassen wir nicht an

Upstream checkt `dist/overlay.json` und `dist/overlay-neutral.json` ein. Bei uns liest niemand die eingecheckten Dateien, der Server baut selbst. Nach `npm run build` ist das Arbeitsverzeichnis schmutzig (neuer Zeitstempel und Hash): normal, verwerfen mit `git checkout -- dist/`. Nie selbst committen. Konfliktiert `dist/` bei einem Merge: `git checkout upstream/main -- dist`.

⚠️ **Die eine Falle:** Wer ohne `npm run build` deployt, liefert upstreams Overlay aus. Heute gibt es keine eigenen Daten, aber die Falle kehrt zurück, sobald wir wieder etwas Eigenes in `src/` haben.

---

## Katalog-Erzeuger (`npm run build:catalogs`)

Der Tracker liest seine Spieldaten (Quests, Items, Hideout, Strings) aus einem Verzeichnis (`TARKOV_DATA_DIR`, nicht aus Cloudflare KV). Dieses Verzeichnis füllt dieser Schritt, aus **diesem** Overlay und `json.tarkov.dev`.

```bash
npm run build:catalogs -- --out ~/tracker-data
# danach:  TARKOV_DATA_DIR=~/tracker-data/current
```

Ablauf: Overlay bauen → Overlay-Paar prüfen (`overlay-neutral.json` muss aus genau diesem `overlay.json` stammen) → **Versions-Wächter** → Tracker-Code auf dem gepinnten Commit auschecken → beide Dateien über einen kurzlebigen HTTPS-Server auf Loopback ausliefern (der Tracker akzeptiert nur `https:`) → Produzent läuft gegen `json.tarkov.dev` und dieses Overlay → Staging-Verzeichnis → prüfen (Manifest, jedes Objekt vorhanden, Größe und SHA-256) → `producer-manifest.json` schreiben → umbenennen nach `releases/<id>` → Symlink `current` atomar umhängen → alte Releases aufräumen (`--keep`, Standard 4). **Jeder Fehler bricht ab, ohne etwas zu veröffentlichen**; das vorige Release bleibt aktiv.

Der Produzent bekommt nur eine Allowlist an Umgebungsvariablen: keine Cloudflare-Zugangsdaten, kein `OVERLAY_TOKEN`.

**Der Pin** liegt in `scripts/producer/tracker.lock.json`: Repo `git@github.com:miwidot/stammtisch-tracker.git`, Commit **`abd13a95…`** (volle 40-stellige SHA, kein Branchname; das ist der Tracker-Commit „offer only German and English"). Warum ein Git-Checkout statt Submodul oder Kopie: der Produzent importiert den halben App-Baum (`neutralCatalog`, `overlay*`, `tarkov-json`); ein Submodul änderte `.gitmodules` und den Index dieses Forks, und eine Kopie müsste bei jedem Tracker-Sync Hunderte Dateien nachziehen. Der Checkout liegt außerhalb des Repos (`~/.cache/stammtisch-overlay-producer`, überschreibbar mit `--tools-dir`/`PRODUCER_TOOLS_DIR`) und wird bei jedem Lauf gegen den Pin und auf lokale Änderungen geprüft.

**Pin anheben:** neue Tracker-SHA eintragen, `npm run build:catalogs`; der neue Checkout entsteht daneben. Der Pin muss im Tracker-Fork gepusht sein. Nötig insbesondere, wenn sich dort die Sprachliste ändert (der Pin bestimmt, welche Katalog-Sprachen entstehen).

**Repo-URL überschreiben:** Auf stammdev gehört der Deploy-Key des Tracker-Forks zum SSH-Alias `github-tracker`; dort `TRACKER_REPO=git@github-tracker:miwidot/stammtisch-tracker.git` setzen (oder `--tracker-repo`). Die SHA bleibt in der Lock-Datei.

**Identität gegenüber `json.tarkov.dev`:** Der Produzent läuft mit bereinigter Umgebung. `build-catalogs.ts` übergibt deshalb `APP_URL` aus **`PRODUCER_APP_URL`** (öffentlicher https-Ursprung, ohne Zugangsdaten, kein lokaler Host, nie `tarkovtracker.org`; ein ungültiger Wert bricht den Lauf ab). Daraus bildet der Tracker seinen User-Agent. Ohne Variable gilt `https://tarkov-stammtisch.de`. Auf stammdev: `PRODUCER_APP_URL=https://trackerdev.tarkov-stammtisch.de`.

### Cron (`scripts/producer/cron-run.sh`)

```bash
17 */12 * * * CATALOG_OUT_DIR=$HOME/tracker-data TRACKER_REPO=git@github-tracker:miwidot/stammtisch-tracker.git PRODUCER_APP_URL=https://trackerdev.tarkov-stammtisch.de ENV_FILE=$HOME/tarkov-stammtisch/.env /pfad/zum/overlay/scripts/producer/cron-run.sh run
47 *    * * * CATALOG_OUT_DIR=$HOME/tracker-data ENV_FILE=$HOME/tarkov-stammtisch/.env /pfad/zum/overlay/scripts/producer/cron-run.sh check-age
```

- **`run` (alle 12 h):** holt zuerst `git fetch --tags origin` (nicht fatal; bei Fehlschlag Alarm, der Lauf geht weiter), dann `npm run build:catalogs -- --out <dir> --keep <N>`. Schreibt `~/tracker-data/releases/<id>` und den Symlink `current`, behält **4** Releases (`PRODUCER_KEEP_RELEASES`). Bei Fehlschlag Discord-Alarm in den Systemlog (`DISCORD_SYSTEM_LOG_WEBHOOK`, aus der Umgebung oder als einzige Variable aus `ENV_FILE` gelesen, die Datei wird nicht ausgeführt; die URL wird nie geloggt).
- **Versions-Wächter:** Liegt die gebaute Overlay-Version **unter** der des aktiven Releases (z. B. 1.184 → 1.67), bricht `build:catalogs` vor jeder Arbeit und vor dem Umhängen von `current` mit **Exit-Code 3** ab (`assertNoVersionRegression` in `scripts/producer/lib.ts`); `cron-run.sh` sendet dafür einen eigenen Alarm, das letzte gute Release bleibt aktiv. Gleiche und höhere Versionen gehen durch, nicht vergleichbare Strings blockieren nicht. Bewusster Rückschritt: einmalig `PRODUCER_ALLOW_VERSION_REGRESSION=1`.
- **`check-age` (stündlich):** alarmiert, wenn das aktive Release älter als `STALE_HOURS` (30) ist oder kein Manifest lesbar ist; Wiederholung höchstens alle `ALERT_REPEAT_HOURS` (6).
- **Löschen, ausdrücklich:** (1) Alte **Releases** räumt der Produzent selbst auf: nur Verzeichnisse `<out>/releases/<id>` mit gültigem Release-Namen, nie das aktive, nie Symlinks; leere, relative, `/`, Home- und Top-Level-Pfade werden abgelehnt. (2) Alte **Tracker-Checkouts** (`tracker-<sha12>`, je rund 1 GB) löscht nur `prune-tools.ts` und nur, wenn `PRODUCER_TOOLS_KEEP` gesetzt ist (Standard: nie), ausschließlich direkte Unterverzeichnisse `tracker-<12 hex>` mit `.producer-ready`-Marker, nie den gepinnten, nie Symlinks. Trockenlauf: `npx tsx scripts/producer/prune-tools.ts --tools-dir <dir> --keep 2 --dry-run`.

**Manifest:** `releases/<id>/producer-manifest.json` enthält Overlay-Version, -Zeitstempel und -SHA (beider Dateien), Tracker-Repo und -Commit, Quelle (`json.tarkov.dev`), Zeitstempel, Anzahl Objekte/Dateien/Bytes und die SHA-256 jeder Datei.

### Parität gegen tarkovtracker.org

```bash
npm run parity -- fetch-live --out /tmp/live
npm run parity -- compare --live /tmp/live --catalogs <out>/current --overlay dist/overlay.json --report parity.md --json parity.json
```

Fragt nur die öffentlichen `GET /api/tarkov/*`-Endpunkte ab, nacheinander, mit Pause und ehrlichem User-Agent; bei 403/429 bricht der Lauf ab, es wird nichts umgangen. Normalisiert werden ausschließlich `dataOverlay.generated`, `dataOverlay.sha256`, `dataOverlay.sourceUrl` und `storedAt`; `dataOverlay.version` bewusst nicht.

---

## Ausliefern

Der Tracker liest `OVERLAY_URL` zur Laufzeit; eine geänderte Overlay-Datei braucht keinen Neubau der App, nur Neustart bzw. Cache-Ablauf (TTL 1 h, `OVERLAY_CACHE_BUSTER` erzwingt sofort). `OVERLAY_URL` darf `https:`, `http:` nur auf Loopback oder `file:` unterhalb von `OVERLAY_FILE_ROOT` sein; alles andere fällt **still** auf die Upstream-Adresse zurück (Details im App-Fork). **`$meta.version` ist Pflicht** in der Datei, sonst wird das Overlay still verworfen; der Build setzt sie automatisch.

---

## Upstream nachziehen

```bash
git fetch upstream --tags
git merge upstream/main      # Konflikt nur bei .github/dependabot.yml (git rm); dist/ kommt von upstream
npm run validate
npm run build                # Rauchtest, danach: git checkout -- dist/
git remote get-url origin    # muss miwidot/stammtisch-tracker-overlay sein, NIE tarkovtracker-org
git push origin --tags       # Pflicht: Upstream-Tags immer mit nach origin
git push origin <branch>
```

Merge-Konflikt in `package.json` nur, wenn Upstream direkt neben unseren zwei `scripts`-Zeilen etwas ändert.

**Wohin Korrekturen gehören:** Deutsche Übersetzungen und sachliche Datenfehler (Level, Map, Händler) gehen als Pull Request an Upstream (über `mirror`), nicht hierher; ein Eintrag in `src/` wäre wieder eine eigene Abweichung. Ausnahme wäre etwas rein Stammtisch-Spezifisches.

---

## Nützliche Upstream-Werkzeuge

| Befehl                    | Zweck                                                                                   |
| ------------------------- | --------------------------------------------------------------------------------------- |
| `npm run build`           | erzeugt `dist/overlay.json`                                                             |
| `npm run validate`        | prüft gegen die JSON-Schemata                                                           |
| `npm run check-overrides` | meldet Korrekturen, die Upstream inzwischen selbst behoben hat                          |
| `npm run status:locale de`| offene und veraltete Übersetzungen je Händler                                           |
| `npm run wiki:compare`    | Abgleich gegen das Fandom-Wiki (liefert Kandidaten, keine Fehler)                       |
| `npm run eft:audit`       | Datenabgleich gegen die Spieldaten                                                      |
| `npm run monitor`         | Weboberfläche zum Durchsehen                                                            |

---

## Rauchtest nach jedem Upstream-Merge

- [ ] `npm run build` läuft durch, `$meta.version` in `dist/overlay.json` vorhanden, Version = höchster `v*`-Tag (`git tag --merged HEAD --list 'v*'`)
- [ ] `npm run validate` und `npx vitest run` grün
- [ ] `npm run build:catalogs` (oder der nächste Cron-Lauf) erzeugt ein Release ohne Versions-Rückschritt, `producer-manifest.json` ist frisch
- [ ] Ein bekannter deutscher Quest-Name kommt im laufenden Tracker an
- [ ] Task-Anzahl im Tracker plausibel (nicht plötzlich rund 30 mehr: das hieße, das Upstream-Overlay fehlt)
- [ ] `git push origin --tags` meldet keine abgelehnten Tags
