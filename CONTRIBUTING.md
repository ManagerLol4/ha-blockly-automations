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
| `www/ha_blocks.js` | **Herzstück:** Blockdefinitionen und Umwandlung HA ↔ Blöcke |
| `www/editor.js` | Laden/Speichern über die HA-API, JSON-Seitenleiste, Selbsttest |
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

## Grundregel

Blockly ist nur Anzeige. Es gibt **kein eigenes Speicherformat** – gespeichert wird immer die
native HA-Automation über `config/automation/config/<id>`. Wenn eine Darstellung nicht
verlustfrei ist, sperrt der Editor das Speichern; das muss so bleiben.

## Selbsttest gegen echte Automationen

Im Panel die Browser-Konsole öffnen, den iframe-Kontext `editor.html` wählen und
`await haBlockly.selfTest()` ausführen. Das prüft alle Automationen auf verlustfreien Rundlauf
(nur lesen, nichts wird gespeichert).
