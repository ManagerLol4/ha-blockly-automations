# Mitmachen

Wir bauen das zu zweit (oder mehr) – so bleibt es übersichtlich:

1. **Branch pro Änderung:** `git switch -c feature/kurzer-name`
2. **Tests vor dem Push:** `npm install` und danach `npm test`. Jede neue Blockart braucht eine
   Beispiel-Automation in `tests/fixtures/` (ohne echte Geräte-IDs/Namen), die den
   Rundlauf HA → Blöcke → HA unverändert übersteht.
3. **Pull Request** gegen `main` öffnen, der andere schaut kurz drüber und merged.
4. **Release:** `node scripts/bump.js x.y.z`, committen, Tag `vx.y.z` pushen und auf GitHub ein
   Release anlegen. Installationen mit der Update-Automation holen es sich dann selbst.

## Wo was liegt

| Datei | Inhalt |
|---|---|
| `custom_components/blockly_automations/__init__.py` | Registriert Panel + statische Dateien |
| `www/panel.js` | Nur ein Lader: liest `version.json` und lädt `panel-main.js` mit Versionsnummer (Updates ohne Neustart) |
| `www/panel-main.js` | Seitenleisten-Element, bettet den Editor als iframe ein; öffnet die originalen HA-Dialoge: „… hinzufügen“ (über eine unsichtbare `ha-automation-trigger/condition/action`-Liste) und Eigenschaften (`ha-automation-*-editor` in `ha-dialog`). Beide hängen im Panel-Element, damit HA-Kontextdaten ankommen |
| `www/version.json` | Aktuelle Version für den Lader – mit `node scripts/bump.js x.y.z` setzen |
| `www/ha_blocks.js` | **Herzstück:** Blockdefinitionen und Umwandlung HA ↔ Blöcke (Automation `ha_root`, Skript `ha_script`, Blueprint-Eingaben). Außerdem ohne Browser testbar: Pfade wie in HA-Traces (`walkConfig`, `collectPaths`), Prüfregeln (`lint`), Querverweise (`references`), Trigger-IDs |
| `www/editor.js` | Laden/Speichern über die HA-API (Automationen und Skripte), Liste, JSON-Seitenleiste, Inspektor (Traces über `trace/list`/`trace/get`, Live über `test_condition`, Template-Vorschau über `render_template`), Querverweise, Selbsttest, Darstellung speichern |
| `__init__.py` | außerdem Websocket-Befehle `blockly_automations/layout/get|set` für eingeklappte Bausteine (`.storage/blockly_automations.layout`) |
| `tests/dev/mock.html` | Test-Seite mit erfundenem Mini-HA (`npm run dev`) – zum Ausprobieren ohne echtes HA |
| `www/vendor/` | Blockly (Apache-2.0), aktualisieren mit `npm run vendor` |

## Neue Blockart hinzufügen

In `ha_blocks.js` in `triggerSpec`, `conditionSpec` oder `actionSpec` einen Fall ergänzen:

```js
case "zone":
  return common("📍 Zone", [F("entity_id", "Person", "always", { entity: true }), F("zone", "Zone"), F("event", "Ereignis")]);
```

- `F(pfad, label, "always" | "present", { entity, numeric, options })` – bearbeitbares Feld
- `L(pfad, label, "trigger" | "condition" | "action" | "option")` – verschachtelte Liste

Alles, was nicht als Feld oder Liste beschrieben ist, bleibt automatisch unverändert erhalten.

## Blockly-Modus

Einstellung `ui_mode` (`ha` | `blockly`) kommt aus dem Options-Flow (`config_flow.py`) über die
Panel-Konfiguration in den Editor (`parent.__haBlocklyConfig`; zum Testen auch `?ui=blockly`).
Im Blockly-Modus ist `HAB.hooks.blockly` gesetzt: Felder vom Typ `entity`, `state`, `service`,
`area`, `device`, `floor`, `time`, `triggerid` und `devauto` werden zu `FieldPicker` (Auswahlliste
mit Suche im Blockly-Dropdown). Die Einträge liefert `hooks.options(type, field)` in `editor.js`.
Neue Auswahl-Arten: Typ in `PICKER` (ha_blocks.js) eintragen und in `hooks.options`/`hooks.optionLabel`
ergänzen. Test-Seite: `tests/dev/mock.html?ui=blockly`.

## Neue Prüfregel hinzufügen

In `lint()` in `ha_blocks.js`: `walkConfig` liefert jedes Element mit Art und Pfad
(z. B. `action/0/choose/1/sequence/0`); `add(path, "warn" | "info", text)` hängt den Hinweis an
den Baustein. Jede Regel bekommt einen Test in `tests/roundtrip.test.js` (Abschnitt „pruefregeln“).

## Grundregel

Blockly ist nur Anzeige. Es gibt **kein eigenes Speicherformat** – gespeichert wird immer die
native HA-Automation über `config/automation/config/<id>`. Wenn eine Darstellung nicht
verlustfrei ist, sperrt der Editor das Speichern; das muss so bleiben.

## Selbsttest gegen echte Automationen

Im Panel die Browser-Konsole öffnen, den iframe-Kontext `editor.html` wählen und
`await haBlockly.selfTest()` ausführen. Das prüft alle Automationen auf verlustfreien Rundlauf
(nur lesen, nichts wird gespeichert).
