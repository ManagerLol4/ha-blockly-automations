# Blockly Automations für Home Assistant

Zeigt deine **normalen Home-Assistant-Automationen** als Blockly-Blöcke an und lässt sie dort
bearbeiten – Auslöser, Bedingungen und Aktionen als Puzzleteile.

- **Kein eigenes Format, keine Parallel-Logik.** Gespeichert wird immer die native HA-Automation
  über dieselbe Schnittstelle wie der eingebaute Editor (`config/automation/config/<id>`).
  Du kannst jederzeit zwischen Blockly und dem HA-Editor wechseln.
- **Verlustfrei:** Jeder Block hält das Original-Objekt. Unbekannte Felder und Blockarten werden
  unverändert durchgereicht (graue Blöcke). Beim Laden prüft der Editor, ob HA → Blöcke → HA
  identisch ist; ist es das nicht, ist Speichern gesperrt.
- **JSON-Seitenleiste:** Zeigt den gewählten Block oder die ganze Automation; dort lässt sich
  auch alles bearbeiten, wofür es noch keinen eigenen Block gibt.

## Installation

### Über HACS (benutzerdefiniertes Repository)

1. HACS → ⋮ → **Benutzerdefinierte Repositories**
2. URL `https://github.com/ManagerLol4/ha-blockly-automations`, Typ **Integration** → Hinzufügen
3. „Blockly Automations“ öffnen → **Herunterladen**
4. Home Assistant neu starten
5. **Einstellungen → Geräte & Dienste → Integration hinzufügen → „Blockly Automations“**
6. In der Seitenleiste erscheint **Automationen** mit dem Puzzle-Symbol (nur für Administratoren)

### Manuell

1. Den Ordner `custom_components/blockly_automations` nach `/config/custom_components/`
   kopieren (z. B. mit dem Add-on *Samba share*, *Studio Code Server* oder *File editor*).
   Fertiges ZIP: unter [Releases](https://github.com/ManagerLol4/ha-blockly-automations/releases).
2. Home Assistant neu starten.
3. **Einstellungen → Geräte & Dienste → Integration hinzufügen → „Blockly Automations“**.

## Bedienung

Aufbau wie der Blockly-Skripteditor in ioBroker: links die Liste, in der Mitte die Blöcke.

1. **Liste links:** Ordner = HA-Kategorien, mit Suche und Ein/Aus-Schalter je Automation.
   Automationen per Drag & Drop in einen anderen Ordner ziehen oder oben über *Kategorie*
   zuweisen; 📁 legt eine neue Kategorie an. Ein Klick öffnet die Automation als Blöcke,
   **＋** legt eine neue an.
2. Blöcke aus dem Werkzeugkasten (Auslöser, Bedingungen, Aktionen, Ablauf) in die Lücken
   ziehen, einfache Werte direkt im Block eintragen.
   - **Zahnrad ⚙ am Block** oder Klick auf ein Auswahlfeld (Entität, Zustand, Dienst) öffnet den
     **originalen HA-Eigenschaften-Dialog** für diesen Auslöser, diese Bedingung oder Aktion –
     mit Entitätssuche, Zustandsauswahl, Zielen und YAML-Umschalter. Das funktioniert auch für
     Geräte-Auslöser und -Aktionen.
   - Dienst-Blöcke zeigen automatisch die Felder des gewählten Dienstes (z. B. Helligkeit bei
     `light.turn_on`). Leere Felder werden nicht gespeichert.
   - Rechtsklick → *Block deaktivieren* entspricht `enabled: false` in HA.
3. **Speichern** schreibt die Automation nach HA (neue Automationen werden dort angelegt),
   liest sie erneut und vergleicht.

| Bereich | Blöcke mit eigenen Feldern |
|---|---|
| Auslöser | Zustand, Zahlenwert, Uhrzeit, Zeitmuster, Sonne, Zone, Template, Home Assistant, Ereignis, Kalender, Sprachbefehl, MQTT, Webhook, NFC-Tag, Benachrichtigung |
| Bedingungen | Zustand, Zahlenwert, Uhrzeit (mit Wochentagen), Sonne, Zone, Auslöser-ID, Template, UND/ODER/NICHT |
| Aktionen | Dienst aufrufen (Felder aus dem HA-Schema), Szene, Ereignis, Variablen |
| Ablauf | Wenn/Dann/Sonst, Auswahl mit Optionen, Warten (Zeit/Template/Auslöser), Wiederholen (Anzahl/solange/bis), Parallel, Folge, Stopp |

Geräte-Auslöser, -Bedingungen und -Aktionen werden als graue Blöcke angezeigt und im HA-Dialog
(⚙) bearbeitet. Die JSON-Seitenleiste (Knopf *JSON*) bleibt als Expertenwerkzeug.

## Entwicklung

```bash
npm install      # Blockly als Dev-Abhängigkeit
npm test         # Rundlauf-Tests (tests/fixtures)
npm run vendor   # Blockly nach www/vendor kopieren (nach einem Update)
```

Mehr in [CONTRIBUTING.md](CONTRIBUTING.md).

## Lizenz

MIT – siehe [LICENSE](LICENSE). Enthält [Blockly](https://github.com/RaspberryPiFoundation/blockly)
(Apache-2.0).
