"""Blockly Automations: zeigt und bearbeitet native HA-Automationen als Blöcke.

Die Integration registriert nur ein Seitenleisten-Panel und liefert die
statischen Frontend-Dateien aus. Gespeichert wird ausschließlich über die
normale HA-Schnittstelle config/automation/config/<id>; es gibt kein eigenes
Speicherformat.

Updates: Frontend-Dateien werden über www/version.json ohne Neustart neu
geladen. Ändern sich Python-Dateien, legt die Integration eine Reparatur-
Meldung „Neustart erforderlich“ an (kein automatischer Neustart).
"""

from __future__ import annotations

from datetime import timedelta
import hashlib
import json
from pathlib import Path

from homeassistant.components import frontend, panel_custom
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.event import async_track_time_interval

from .const import DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL, STATIC_URL

BASE_DIR = Path(__file__).parent
WWW_DIR = BASE_DIR / "www"
RESTART_ISSUE = "restart_required"
CHECK_INTERVAL = timedelta(minutes=5)


def _version() -> str:
    manifest = BASE_DIR / "manifest.json"
    return json.loads(manifest.read_text(encoding="utf-8"))["version"]


def _code_hash() -> str:
    """Prüfsumme über alles, was erst nach einem Neustart wirkt."""
    digest = hashlib.sha256()
    files = sorted(BASE_DIR.glob("*.py")) + [WWW_DIR / "panel.js", BASE_DIR / "manifest.json"]
    for path in files:
        if not path.exists():
            continue
        data = path.read_bytes()
        if path.name == "manifest.json":
            # Die Versionsnummer allein erfordert keinen Neustart.
            manifest = json.loads(data)
            manifest.pop("version", None)
            data = json.dumps(manifest, sort_keys=True).encode()
        digest.update(path.name.encode() + b"\0" + data)
    return digest.hexdigest()


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

    # Nach einem Neustart ist der geladene Code aktuell: alte Meldung entfernen.
    ir.async_delete_issue(hass, DOMAIN, RESTART_ISSUE)
    loaded_hash = await hass.async_add_executor_job(_code_hash)

    async def _check_for_new_code(_now=None) -> None:
        current = await hass.async_add_executor_job(_code_hash)
        if current != loaded_hash:
            new_version = await hass.async_add_executor_job(_version)
            ir.async_create_issue(
                hass,
                DOMAIN,
                RESTART_ISSUE,
                is_fixable=False,
                is_persistent=False,
                severity=ir.IssueSeverity.WARNING,
                translation_key=RESTART_ISSUE,
                translation_placeholders={"version": new_version},
            )

    entry.async_on_unload(async_track_time_interval(hass, _check_for_new_code, CHECK_INTERVAL))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Panel wieder entfernen."""
    frontend.async_remove_panel(hass, PANEL_URL)
    return True
