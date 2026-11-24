"""Blockly Automations: zeigt und bearbeitet native HA-Automationen als Blöcke.

Die Integration registriert nur ein Seitenleisten-Panel und liefert die
statischen Frontend-Dateien aus. Gespeichert wird ausschließlich über die
normale HA-Schnittstelle config/automation/config/<id>; es gibt kein eigenes
Speicherformat.

Darstellung (eingeklappte Bausteine) liegt getrennt davon in
.storage/blockly_automations.layout – die Automation selbst bleibt unberührt.

Updates: Frontend-Dateien werden über www/version.json ohne Neustart neu
geladen. Ändern sich Python-Dateien, legt die Integration eine Reparatur-
Meldung „Neustart erforderlich“ an (kein automatischer Neustart).
"""

from __future__ import annotations

from datetime import timedelta
import hashlib
import json
from pathlib import Path

import voluptuous as vol

from homeassistant.components import frontend, panel_custom, websocket_api
from homeassistant.components.http import StaticPathConfig
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import issue_registry as ir
from homeassistant.helpers.event import async_track_time_interval
from homeassistant.helpers.storage import Store

from .const import BLOCK_SET_NATIVE, BLOCK_SETS, CONF_BLOCK_SET, CONF_UI_MODE, DOMAIN, PANEL_ICON, PANEL_TITLE, PANEL_URL, STATIC_URL, UI_MODE_HA, UI_MODES

BASE_DIR = Path(__file__).parent
WWW_DIR = BASE_DIR / "www"
RESTART_ISSUE = "restart_required"
CHECK_INTERVAL = timedelta(minutes=5)
LAYOUT_STORE_KEY = f"{DOMAIN}.layout"
LAYOUT_STORE_VERSION = 1
LAYOUT_MAX_KEYS = 2000


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


@websocket_api.websocket_command(
    {vol.Required("type"): f"{DOMAIN}/layout/get", vol.Required("key"): str}
)
@websocket_api.require_admin
@callback
def _ws_layout_get(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Darstellung einer Automation/eines Skripts lesen (oder None)."""
    layouts = hass.data[DOMAIN]["layouts"]
    connection.send_result(msg["id"], layouts.get(msg["key"]))


@websocket_api.websocket_command(
    {
        vol.Required("type"): f"{DOMAIN}/layout/set",
        vol.Required("key"): vol.All(str, vol.Length(min=1, max=300)),
        vol.Required("layout"): vol.Any(None, dict),
    }
)
@websocket_api.require_admin
@callback
def _ws_layout_set(hass: HomeAssistant, connection: websocket_api.ActiveConnection, msg: dict) -> None:
    """Darstellung speichern; None löscht den Eintrag."""
    data = hass.data[DOMAIN]
    layouts: dict = data["layouts"]
    if msg["layout"] is None:
        layouts.pop(msg["key"], None)
    elif msg["key"] in layouts or len(layouts) < LAYOUT_MAX_KEYS:
        layouts[msg["key"]] = msg["layout"]
    else:
        connection.send_error(msg["id"], "too_many", "Zu viele gespeicherte Darstellungen")
        return
    data["layout_store"].async_delay_save(lambda: layouts, 2)
    connection.send_result(msg["id"])


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Panel und statische Dateien registrieren."""
    data = hass.data.setdefault(DOMAIN, {})
    version = await hass.async_add_executor_job(_version)

    if "layout_store" not in data:
        store: Store = Store(hass, LAYOUT_STORE_VERSION, LAYOUT_STORE_KEY)
        data["layout_store"] = store
        data["layouts"] = (await store.async_load()) or {}
        websocket_api.async_register_command(hass, _ws_layout_get)
        websocket_api.async_register_command(hass, _ws_layout_set)

    if not data.get("static_registered"):
        await hass.http.async_register_static_paths(
            [StaticPathConfig(STATIC_URL, str(WWW_DIR), False)]
        )
        data["static_registered"] = True

    ui_mode = entry.options.get(CONF_UI_MODE, UI_MODE_HA)
    if ui_mode not in UI_MODES:
        ui_mode = UI_MODE_HA
    block_set = entry.options.get(CONF_BLOCK_SET, BLOCK_SET_NATIVE)
    if block_set not in BLOCK_SETS:
        block_set = BLOCK_SET_NATIVE
    await panel_custom.async_register_panel(
        hass,
        frontend_url_path=PANEL_URL,
        webcomponent_name="ha-blockly-automations-panel",
        sidebar_title=PANEL_TITLE,
        sidebar_icon=PANEL_ICON,
        module_url=f"{STATIC_URL}/panel.js?v={version}",
        config={"static_url": STATIC_URL, "version": version, "ui_mode": ui_mode, "block_set": block_set},
        require_admin=True,
    )

    # Nach einem Neustart ist der geladene Code aktuell: alte Meldung entfernen.
    # Nur beim ersten Laden im Prozess – ein Neuladen (z. B. nach Änderung der
    # Einstellungen) lädt keinen neuen Python-Code.
    if "loaded_hash" not in data:
        ir.async_delete_issue(hass, DOMAIN, RESTART_ISSUE)
        data["loaded_hash"] = await hass.async_add_executor_job(_code_hash)
    loaded_hash = data["loaded_hash"]

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
    # Geänderte Einstellungen: Panel mit neuer Konfiguration neu anmelden.
    entry.async_on_unload(entry.add_update_listener(_async_options_updated))
    return True


async def _async_options_updated(hass: HomeAssistant, entry: ConfigEntry) -> None:
    await hass.config_entries.async_reload(entry.entry_id)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Panel wieder entfernen."""
    frontend.async_remove_panel(hass, PANEL_URL)
    return True
