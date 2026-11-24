# Blockly Automations für Home Assistant

Zeigt deine **normalen Home-Assistant-Automationen** als Puzzle-Bausteine – übersichtlich als
Satz: **WENN** … **NUR WENN** … **DANN** … Gedacht für alle, auch ohne Technikkenntnisse.

- **Kein eigenes Format.** Gespeichert wird immer die native HA-Automation über dieselbe
  Schnittstelle wie der eingebaute Editor (`config/automation/config/<id>`). Du kannst jederzeit
  zwischen diesem Editor und dem HA-Editor wechseln.
- **Originale HA-Auswahl:** Hinzufügen und Ändern laufen über die bekannten HA-Dialoge
  (Suche, *Nach Ziel*, *Nach Typ*, Entitäts- und Zustandsauswahl).
- **Verlustfrei:** Jeder Baustein hält das Original. Beim Laden prüft der Editor, ob
  HA → Bausteine → HA identisch ist; sonst ist Speichern gesperrt.

## Installation

### Über den HA-Marketplace bzw. HACS (benutzerdefiniertes Repository)

1. *Marketplace → Über Link hinzufügen* (bzw. HACS → ⋮ → *Benutzerdefinierte Repositories*,
   Typ **Integration**): `https://github.com/ManagerLol4/ha-blockly-automations`
2. „Blockly Automations“ öffnen → **Installieren** / **Herunterladen**
3. Home Assistant neu starten
4. **Einstellungen → Geräte & Dienste → Integration hinzufügen → „Blockly Automations“**
5. In der Seitenleiste erscheint **Automationen** mit dem Puzzle-Symbol (nur für Administratoren)

### Manuell

1. Den Ordner `custom_components/blockly_automations` nach `/config/custom_components/`
   kopieren (z. B. mit *Samba share*, *Studio Code Server* oder *File editor*).
2. Home Assistant neu starten und die Integration wie oben hinzufügen.

## Bedienung

### Zwei Arten zu bearbeiten (Einstellung)

Unter **Einstellungen → Geräte & Dienste → Blockly Automations → Konfigurieren** (oder ⚙ oben im
Editor) wählst du die **Bedienung**:

| | Home-Assistant-Auswahlfenster (Standard) | Blockly-Bausteine |
|---|---|---|
| Werte ändern | Wert im Baustein anklicken → originales HA-Fenster | direkt im Baustein: Auswahlliste mit Suche (Entitäten nach Art gruppiert, Bereiche, Geräte, Zustände, Dienste, Zeiten) – eigene Werte/Templates mit Enter |
| Hinzufügen | „＋ … hinzufügen“ öffnet den HA-Dialog | „＋ … hinzufügen“ öffnet die passende Kategorie im Werkzeugkasten; Bausteine in die Lücke ziehen |
| Werkzeugkasten | wenige, einfache Bausteine | alle Auslöser, Bedingungen, Abläufe, **alle Dienste** (nach Integration), **Geräte-Auslöser/-Bedingungen/-Aktionen** (Gerät wählen → Art wählen) |
| Gedacht für | Einsteiger | Umsteiger aus ioBroker, alle, die lieber mit Bausteinen arbeiten |

Beide speichern dieselbe native HA-Automation; man kann jederzeit umschalten.

### Im Blockly-Modus zusätzlich

- **Werte & Logik:** Bausteine wie *Zustand von …*, *Zahl von …*, *Attribut*, *Auslöser: neuer Zustand*,
  *Variable*, *jetzt*, Vergleichen (=, ≠, <, >), *und/oder/nicht*, Rechnen, Runden, Text verbinden,
  *wenn … dann … sonst*. Sie stecken in Datenfeldern (z. B. Nachricht, Helligkeit), Variablen und in der
  **Bedingung aus Logik-Bausteinen**. Beim Speichern wird daraus ein normales Jinja-Template; ein
  unsichtbarer Kommentar `{#hab:…#}` merkt sich die Bausteine. Von Hand geänderte Templates bleiben Text.
- **Variablen:** „＋ Variable“ in *Variablen setzen*; *Variable*-Baustein mit Auswahl der vorhandenen Namen.
- **＋ sonst wenn …** am *Wenn*-Baustein (wird dabei zur Auswahl mit mehreren Zweigen).
- **Als neues Skript auslagern** (Rechtsklick auf einen Schritt): legt das Skript an und setzt den Aufruf ein.
- **🔎 Suche im Werkzeugkasten**, **Suche im Arbeitsbereich** (Strg+F), **⤢ Alles zeigen**.
- **Kopieren zwischen Automationen** (Rechtsklick → kopieren / einfügen, auch Strg+C/V über Automationen hinweg).
- **🎒 Rucksack** (oben rechts): Lieblings-Bausteine für alle Automationen, in HA gespeichert.
- **Mehrfachauswahl:** Shift+Klick markiert mehrere Bausteine; Rechtsklick → alle deaktivieren, aktivieren,
  einklappen, löschen oder in den Rucksack.
- **🗒 Notizen** (Rechtsklick auf freie Fläche) – gespeichert mit der Darstellung, nicht in der Automation.
- **YAML-Ansicht** des gewählten Bausteins im Inspektor (🔍).
- Eingaben (Namen, neue Skripte, Kategorien) über ein eigenes Fenster – funktioniert auch in der HA-App.

Aufbau wie der Blockly-Skripteditor in ioBroker: links die Liste, rechts die Bausteine.

1. **Liste links:** Ordner = HA-Kategorien, mit Suche und Ein/Aus-Schalter. Automationen mit der
   Maus in einen anderen Ordner ziehen oder oben über *Ordner* zuweisen; 📁 legt einen neuen an.
2. **＋ Neu** (oben): leer beginnen oder eine **Vorlage** wählen – *Licht bei Bewegung*,
   *Meldung, wenn Fenster lange offen*, *Jeden Tag zu einer Uhrzeit*, *Licht bei Sonnenuntergang*.
3. **„＋ Auslöser/Bedingung/Aktion hinzufügen“** in jeder Lücke öffnet den originalen
   HA-Dialog. Danach öffnen sich direkt die Einstellungen des neuen Bausteins.
4. **Werte im Baustein anklicken** (z. B. *Entität: Tür Badezimmer · zu: Geöffnet · für: 3 Sek*):
   - Entität/Ziel öffnet ein Auswahlfenster wie der HA-Dialog – Suche oben, links Räume/Geräte als
     Baum, rechts die passenden Entitäten nach Art gruppiert; bei Aktionen auch „ganzen Raum verwenden“.
   - Zustand, Uhrzeit, Dauer, Zahl, Ja/Nein und Listen öffnen die originalen HA-Auswahlfelder.
   - ⚙ öffnet alle Einstellungen des Bausteins im HA-Dialog.
5. Bausteine lassen sich verschieben, kopieren und per Rechtsklick deaktivieren
   (= `enabled: false` in HA). ⚠ zeigt, wo noch etwas ausgewählt werden muss.
   ↶/↷ macht Schritte rückgängig.
6. **Speichern** schreibt die Automation nach HA; **Verwerfen** lädt den gespeicherten Stand.

7. **Name / Kommentar** (Rechtsklick auf einen Baustein): setzt den HA-Namen (`alias`) des Schritts.
   Er steht dann im Baustein – auch eingeklappt – und im Ablauf-Protokoll von HA.
8. **Einklappen** (Rechtsklick): bleibt gespeichert, ohne die Automation zu verändern
   (eigener Speicher unter `.storage/blockly_automations.layout`).

### Skripte als Funktionen

Oben in der Liste zwischen **🤖 Automationen** und **📜 Skripte** umschalten. Skripte werden genauso
als Bausteine bearbeitet (Gespeichert über `config/script/config/<id>`). Im Werkzeugkasten unter
**Skripte (Funktionen)** liegt jedes Skript als Aufruf-Baustein – seine **Eingaben** erscheinen dort
als Felder. So baut man Abläufe einmal und nutzt sie in vielen Automationen.

### Sehen, was passiert: 🔍 Ablauf & Werte

- **Letzte Abläufe (Traces):** einen Lauf auswählen – ausgeführte Bausteine werden **grün**
  umrandet, Bedingungen, die nicht erfüllt waren, **orange**, Fehler **rot**, nicht erreichte
  Bausteine blass. Beim Anklicken eines Bausteins stehen rechts Zeitpunkt, Ergebnis und Variablen.
- **Live:** prüft alle Bedingungen jetzt (gestrichelt grün = erfüllt, rot = nicht erfüllt) und
  zeigt die aktuellen Zustände der Entitäten des gewählten Bausteins.
- **Template-Vorschau:** Templates im gewählten Baustein werden live ausgewertet.
- **Hinweise:** Prüfregeln für typische Stolperfallen, z. B. unbekannte Trigger-ID, lange
  Wartezeit (übersteht keinen Neustart → Timer-Helfer), Modus „single“ mit Wartezeit, Automation
  ohne Auslöser. Hinweise erscheinen auch als 💡 am Baustein; Anklicken springt hin.

### 🔗 Querverweise

Zeigt für jede Entität, welche Automationen/Skripte auf sie **auslösen**, sie **prüfen**, sie
**schalten** oder (bei Skripten) sie **aufrufen** – auch aus Templates. Klick öffnet die Stelle.

### Weitere Werkzeuge

- **„Ausgelöst durch ID“** bietet die Trigger-IDs der Automation zur Auswahl an.
- **Blueprints:** Automationen und Skripte aus Blueprints zeigen ihre Eingaben als Felder.
- **🧪 Alle prüfen** (unten in der Liste): prüft alle Automationen bzw. Skripte auf verlustfreie
  Darstellung und listet Ausnahmen auf.

**Expertenmodus (🔧):** Eingabefelder direkt im Baustein, alle Bausteinarten und die
JSON-Seitenleiste.

## Tipps: komplexe Automationen übersichtlich bauen

1. **In Schichten denken:** Sensoren → abgeleitete Zustände (Helfer/Template-Sensoren wie
   `binary_sensor.jemand_zuhause`, `input_select.hausmodus`) → Automationen, die nur auf diese
   Zustände reagieren → Skripte, die etwas ausführen. Tauscht man einen Sensor, ändert sich nur
   eine Stelle.
2. **Eine Aufgabe pro Automation**, mehrere Auslöser mit **Trigger-IDs** und eine **Auswahl**
   (siehe Vorlage *Licht bei Bewegung*) statt vieler kleiner, sich überschneidender Automationen.
3. **Skripte als Funktionen** mit Eingaben (z. B. `raum`, `helligkeit`) für alles, was mehrfach
   vorkommt.
4. **Timer-Helfer statt langer Wartezeiten** – sichtbar, abbrechbar und neustartfest.
5. **Manuell übersteuern:** ein `input_boolean` (+ Timer), das eine Automation vorübergehend sperrt.
6. **Den Modus bewusst wählen:** `restart` für Bewegungslicht, `queued` für Meldungen.
7. **Benennen:** „Bereich: Gerät – Verhalten“ (z. B. *Bad: Licht – Bewegung*), Ordner/Kategorien,
   und wichtige Schritte mit *Name / Kommentar* versehen – dann liest sich der Ablauf wie ein Satz.

## Updates

- Neue Versionen werden im Marketplace angezeigt; das Panel fragt beim Öffnen selbst nach.
- Der Editor lädt Neuerungen **ohne HA-Neustart** (nur die Seite neu laden).
- Enthält ein Update Python-Änderungen, erscheint unter *Einstellungen → Reparaturen* der Hinweis
  **„Neustart erforderlich“** – es wird nie automatisch neu gestartet.
- Automatisch installieren: eine HA-Automation wie diese installiert jedes neue Update selbst.

```yaml
alias: "System: Blockly Automations aktualisieren"
triggers:
  - trigger: state
    entity_id: update.blockly_automations
    to: "on"
  - trigger: time_pattern
    minutes: "17"
conditions:
  - condition: state
    entity_id: update.blockly_automations
    state: "on"
actions:
  - action: update.install
    target:
      entity_id: update.blockly_automations
mode: queued
```

## Entwicklung

```bash
npm install                  # Blockly als Dev-Abhängigkeit
npm test                     # Rundlauf-Tests (tests/fixtures)
npm run dev                  # Test-Seite ohne HA: http://localhost:8790/tests/dev/mock.html
node scripts/bump.js 0.4.3   # Versionsnummer überall setzen (manifest, package.json, version.json)
npm run vendor               # Blockly nach www/vendor kopieren (nach einem Blockly-Update)
```

Mehr in [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

MIT – siehe [LICENSE](LICENSE). Enthält [Blockly](https://github.com/RaspberryPiFoundation/blockly)
(Apache-2.0).
