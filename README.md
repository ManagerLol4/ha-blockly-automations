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

Aufbau wie der Blockly-Skripteditor in ioBroker: links die Liste, rechts die Bausteine.

1. **Liste links:** Ordner = HA-Kategorien, mit Suche und Ein/Aus-Schalter. Automationen mit der
   Maus in einen anderen Ordner ziehen oder oben über *Ordner* zuweisen; 📁 legt einen neuen an.
2. **＋ Neu** (oben): leer beginnen oder eine **Vorlage** wählen – *Licht bei Bewegung*,
   *Meldung, wenn Fenster lange offen*, *Jeden Tag zu einer Uhrzeit*, *Licht bei Sonnenuntergang*.
3. **„＋ Auslöser/Bedingung/Aktion hinzufügen“** in jeder Lücke öffnet den originalen
   HA-Dialog. Danach öffnen sich direkt die Einstellungen des neuen Bausteins.
4. **Auf einen Satz klicken** (z. B. „Tür Badezimmer wechselt auf Geöffnet“) oder auf ⚙ öffnet
   die originale HA-Auswahl zum Ändern.
5. Bausteine lassen sich verschieben, kopieren und per Rechtsklick deaktivieren
   (= `enabled: false` in HA). ⚠ zeigt, wo noch etwas ausgewählt werden muss.
   ↶/↷ macht Schritte rückgängig.
6. **Speichern** schreibt die Automation nach HA; **Verwerfen** lädt den gespeicherten Stand.

**Expertenmodus (🔧):** Eingabefelder direkt im Baustein, alle Bausteinarten und die
JSON-Seitenleiste.

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
node scripts/bump.js 0.4.3   # Versionsnummer überall setzen (manifest, package.json, version.json)
npm run vendor               # Blockly nach www/vendor kopieren (nach einem Blockly-Update)
```

Mehr in [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

MIT – siehe [LICENSE](LICENSE). Enthält [Blockly](https://github.com/RaspberryPiFoundation/blockly)
(Apache-2.0).
