"""Konstanten für Blockly Automations."""

DOMAIN = "blockly_automations"
PANEL_URL = "blockly-automations"
PANEL_TITLE = "Automationen"
ENTRY_TITLE = "Blockly Automations"
PANEL_ICON = "mdi:puzzle"
STATIC_URL = "/blockly_automations_static"

# Einstellung: wie Bausteine bearbeitet werden.
CONF_UI_MODE = "ui_mode"
UI_MODE_HA = "ha"            # Auswahl über die originalen HA-Fenster (Standard)
UI_MODE_BLOCKLY = "blockly"  # alles direkt im Baustein (wie der Blockly-Editor von ioBroker)
UI_MODES = [UI_MODE_HA, UI_MODE_BLOCKLY]
