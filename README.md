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

![Blockly Automations](docs/screenshot.png)

## Installation

### Über HACS (benutzerdefiniertes Repository)

1. HACS → ⋮ → **Benutzerdefinierte Repositories**
2. URL `https://github.com/ManagerLol4/ha-blockly-automations`, Typ **Integration** → Hinzufügen
3. „Blockly Automations“ öffnen → **Herunterladen**
4. Home Assistant neu starten
5. **Einstellungen → Geräte & Dienste → Integration hinzufügen → „Blockly Automations“**
6. In der Seitenleiste erscheint **Blockly** (nur für Administratoren)

### Manuell

1. Den Ordner `custom_components/blockly_automations` nach `/config/custom_components/`
   kopieren (z. B. mit dem Add-on *Samba share*, *Studio Code Server* oder *File editor*).
   Fertiges ZIP: unter [Releases](https://github.com/ManagerLol4/ha-blockly-automations/releases).
2. Home Assistant neu starten.
3. **Einstellungen → Geräte & Dienste → Integration hinzufügen → „Blockly Automations“**.

## Bedienung

1. Oben eine Automation wählen – sie erscheint als Blöcke.
2. Werte direkt in den Blöcken ändern (Uhrzeit, Entität, Zustand …) oder Blöcke aus dem
   Werkzeugkasten links ziehen.
3. **Speichern** schreibt die Automation nach HA zurück, liest sie erneut und vergleicht.

Aktuell mit eigenen Feldern: Auslöser *Zeit, Zustand, Zahlenwert, Sonne, Zeitmuster, Template,
Home Assistant, Ereignis*; Bedingungen *Zustand, Zahlenwert, Zeit, Sonne, Auslöser-ID, Template,
Zone, UND/ODER/NICHT*; Aktionen *Dienstaufruf, Verzögerung, Warten, Wenn/Dann/Sonst, Auswahl
(choose), Wiederholen, Parallel, Folge, Ereignis, Szene, Variablen, Stopp*. Geräte-Auslöser und
-Aktionen werden angezeigt und unverändert erhalten.

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
