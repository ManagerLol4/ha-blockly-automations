"""Blockly Automations: zeigt und bearbeitet native HA-Automationen als Blöcke.

Die Integration registriert nur ein Seitenleisten-Panel und liefert die
statischen Frontend-Dateien aus. Gespeichert wird ausschließlich über die
normale HA-Schnittstelle config/automation/config/<id>; es gibt kein eigenes
Speicherformat.
"""

from __future__ import annotations

import json
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from .const import DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL, STATIC_URL

WWW_DIR = Path(__file__).parent / "www"


def _version() -> str:
    manifest = Path(__file__).parent / "manifest.json"
    return json.loads(manifest.read_text(encoding="utf-8"))["version"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Panel und statische Dateien registrieren."""
    data = hass.data.setdefault(DOMAIN, {})
    version = await hass.async_add_executor_job(_version)

    if not data.get("static_registered"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(WWW_DIR), False)]
        )
        data["static_registered"] = True

    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name="ha-blockly-automations-panel",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/panel.js?v={version}",
        config={"static_url": STATIC_URL, "version": version},
        require_admin=True,
    )
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Panel wieder entfernen."""
    frontend.async_remove_panel(hass, PANEL_URL)
    return True
