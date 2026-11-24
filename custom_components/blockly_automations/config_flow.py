"""Einrichtung ohne Eingaben: ein Klick fügt das Panel hinzu.

Unter „Konfigurieren“ lässt sich einstellen, ob Bausteine über die originalen
HA-Auswahlfenster oder vollständig in Blockly bearbeitet werden.
"""

from __future__ import annotations

from typing import Any

import voluptuous as vol

from homeassistant.config_entries import ConfigEntry, ConfigFlow, ConfigFlowResult, OptionsFlow
from homeassistant.core import callback
from homeassistant.helpers.selector import SelectSelector, SelectSelectorConfig, SelectSelectorMode

from .const import CONF_UI_MODE, DOMAIN, ENTRY_TITLE, UI_MODE_HA, UI_MODES


class BlocklyAutomationsConfigFlow(ConfigFlow, domain=DOMAIN):
    """Config Flow mit genau einer Instanz."""

    VERSION = 1

    async def async_step_user(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        if user_input is not None:
            return self.async_create_entry(title=ENTRY_TITLE, data={})
        return self.async_show_form(step_id="user")

    @staticmethod
    @callback
    def async_get_options_flow(config_entry: ConfigEntry) -> OptionsFlow:
        return BlocklyAutomationsOptionsFlow()


class BlocklyAutomationsOptionsFlow(OptionsFlow):
    """Einstellungen: Bedienung über HA-Fenster oder vollständig in Blockly."""

    async def async_step_init(
        self, user_input: dict[str, Any] | None = None
    ) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(data=user_input)
        current = self.config_entry.options.get(CONF_UI_MODE, UI_MODE_HA)
        schema = vol.Schema(
            {
                vol.Required(CONF_UI_MODE, default=current): SelectSelector(
                    SelectSelectorConfig(
                        options=UI_MODES,
                        mode=SelectSelectorMode.LIST,
                        translation_key=CONF_UI_MODE,
                    )
                )
            }
        )
        return self.async_show_form(step_id="init", data_schema=schema)
