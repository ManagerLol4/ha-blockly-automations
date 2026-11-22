// Seitenleisten-Panel: bettet den Blockly-Editor als iframe ein (Blockly braucht
// globale Styles, die im Shadow-DOM von HA nicht ankommen) und stellt ihm den
// nativen HA-Eigenschaften-Dialog zur Verfügung. Der Dialog hängt bewusst in
// diesem Element (also im HA-Komponentenbaum), damit Entitäts- und
// Zustandsauswahl ihre Daten von HA bekommen.
const EDITORS = {
  trigger: ["ha-automation-trigger-editor", "trigger"],
  condition: ["ha-automation-condition-editor", "condition"],
  action: ["ha-automation-action-editor", "action"],
};

class HaBlocklyAutomationsPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._panel = null;
    this._narrow = false;
    this._frame = null;
    this._loading = null;
    this._openEditor = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (this._openEditor) this._openEditor.hass = hass;
    this._push();
  }

  set panel(panel) {
    this._panel = panel;
    this._render();
  }

  set narrow(narrow) {
    this._narrow = narrow;
    this._push();
  }

  connectedCallback() {
    this._render();
  }

  _render() {
    if (this._frame || !this.isConnected) return;
    const cfg = (this._panel && this._panel.config) || {};
    const base = cfg.static_url || "/blockly_automations_static";
    const v = window.__haBlocklyVersion || cfg.version || "dev";
    // 100% greift im HA-Panel-Container nicht zuverlässig, daher Viewport-Höhe.
    this.style.cssText = "display:block;height:100vh;height:100dvh;overflow:hidden;";
    const frame = document.createElement("iframe");
    frame.src = `${base}/editor.html?v=${encodeURIComponent(v)}`;
    frame.style.cssText = "border:0;width:100%;height:100%;display:block;";
    frame.addEventListener("load", () => this._push());
    this.appendChild(frame);
    this._frame = frame;
    // Schnittstellen für den Editor im iframe.
    window.__haBlocklyToggleMenu = () =>
      this.dispatchEvent(new Event("hass-toggle-menu", { bubbles: true, composed: true }));
    window.__haBlocklyEditItem = (kind, item, title) => this._editItem(kind, item, title);
    window.__haBlocklyAddItem = (kind) => this._addItem(kind);
    window.__haBlocklyPrepare = () => this._ensureComponents();
    this._refreshMarketplace();
  }

  // Bittet den Marketplace, nach einer neuen Version dieses Repos zu schauen
  // (dasselbe wie „Informationen aktualisieren“). Die eigentliche Installation
  // erledigt die HA-Automation „System: Blockly Automations aktualisieren“.
  async _refreshMarketplace() {
    for (let i = 0; i < 20 && !this._hass; i++) await new Promise((r) => setTimeout(r, 250));
    if (!this._hass || !this._hass.user || !this._hass.user.is_admin) return;
    try {
      const list = await this._hass.callWS({ type: "marketplace/repositories/list" });
      const repos = Array.isArray(list) ? list : (list && list.repositories) || [];
      const mine = repos.find((r) => r.domain === "blockly_automations" || r.full_name === "ManagerLol4/ha-blockly-automations");
      if (mine) await this._hass.callWS({ type: "marketplace/repository/refresh", repository: String(mine.id) });
    } catch (e) {
      /* kein Marketplace (z. B. HACS oder manuelle Installation) – egal */
    }
  }

  _push() {
    const w = this._frame && this._frame.contentWindow;
    if (w && w.haBlockly && this._hass) {
      w.haBlockly.setHass(this._hass, this._narrow);
    }
  }

  // Lädt die Automations-Editor-Bausteine von HA (sind sonst erst nach einem
  // Besuch des eingebauten Editors registriert) und deren Übersetzungen.
  _ensureComponents() {
    if (!this._loading) {
      this._loading = (async () => {
        try {
          if (!customElements.get("ha-automation-trigger-editor")) {
            const ha = document.querySelector("home-assistant");
            const main = ha && ha.shadowRoot && ha.shadowRoot.querySelector("home-assistant-main");
            const ppr = main && main.shadowRoot && main.shadowRoot.querySelector("partial-panel-resolver");
            const routes = ppr && ppr.routerOptions && ppr.routerOptions.routes;
            if (routes && routes.config && routes.config.load) await routes.config.load();
            const cfg = document.createElement("ha-panel-config");
            const r = cfg.routerOptions && cfg.routerOptions.routes;
            if (r && r.automation && r.automation.load) await r.automation.load();
          }
          if (this._hass && this._hass.loadFragmentTranslation) await this._hass.loadFragmentTranslation("config");
        } catch (e) {
          console.warn("[Blockly Automations] HA-Editor konnte nicht geladen werden", e);
        }
        return Object.values(EDITORS).every(([tag]) => customElements.get(tag)) && !!customElements.get("ha-dialog");
      })();
    }
    return this._loading;
  }

  // Öffnet den originalen HA-Dialog „Auslöser/Bedingung/Aktion hinzufügen“
  // (Suche, „Nach Ziel“, „Nach Typ“). Dafür wird eine unsichtbare HA-Liste
  // benutzt; was HA ihr hinzufügt, ist das Ergebnis. So entsteht das Element
  // exakt wie im eingebauten Editor. Ergebnis: Liste neuer Elemente, [] bei
  // Abbruch, undefined wenn nicht verfügbar.
  async _addItem(kind) {
    const LISTS = {
      trigger: ["ha-automation-trigger", "triggers", "_addTriggerDialog"],
      condition: ["ha-automation-condition", "conditions", "_addConditionDialog"],
      action: ["ha-automation-action", "actions", "_addActionDialog"],
    };
    if (!LISTS[kind] || !(await this._ensureComponents())) return undefined;
    const [tag, prop, method] = LISTS[kind];
    if (!customElements.get(tag) || typeof customElements.get(tag).prototype[method] !== "function") return undefined;
    const el = document.createElement(tag);
    el.hass = this._hass;
    el[prop] = [];
    el.narrow = false;
    el.style.display = "none";
    let added = [];
    el.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      if (e.detail && Array.isArray(e.detail.value)) {
        added = e.detail.value;
        el[prop] = added;
      }
    });
    // Nebenwirkungen des HA-Editors (Seitenleiste öffnen o. Ä.) nicht nach oben lassen.
    for (const ev of ["open-sidebar", "close-sidebar", "request-close-sidebar", "item-selected"]) {
      el.addEventListener(ev, (e) => e.stopPropagation());
    }
    this.appendChild(el);
    await new Promise((r) => requestAnimationFrame(r));
    const dialog = () => {
      const ha = document.querySelector("home-assistant");
      return ha && ha.shadowRoot && ha.shadowRoot.querySelector("add-automation-element-dialog");
    };
    try {
      el[method]();
    } catch (e) {
      el.remove();
      return undefined;
    }
    // Warten, bis der Dialog offen war und wieder zu ist.
    let opened = false;
    for (let i = 0; i < 6000; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const d = dialog();
      const isOpen = !!(d && d._params);
      if (isOpen) opened = true;
      if ((opened && !isOpen) || (!opened && i > 40)) break;
    }
    await new Promise((r) => setTimeout(r, 200));
    el.remove();
    return JSON.parse(JSON.stringify(added));
  }

  // Öffnet den nativen HA-Editor für einen Auslöser/eine Bedingung/Aktion.
  // Ergebnis: das geänderte Objekt oder null (abgebrochen).
  async _editItem(kind, item, title) {
    if (!EDITORS[kind] || !(await this._ensureComponents())) return undefined;
    const [tag, prop] = EDITORS[kind];
    return new Promise((resolve) => {
      let value = JSON.parse(JSON.stringify(item));
      let done = false;
      const dlg = document.createElement("ha-dialog");
      dlg.headerTitle = title || "Eigenschaften";
      dlg.width = "medium";
      const ed = document.createElement(tag);
      ed.hass = this._hass;
      ed[prop] = value;
      ed.uiSupported = true;
      ed.narrow = this._narrow;
      ed.style.display = "block";
      ed.addEventListener("value-changed", (e) => {
        e.stopPropagation();
        if (e.detail && e.detail.value !== undefined) {
          value = e.detail.value;
          ed[prop] = value;
        }
      });
      dlg.appendChild(ed);

      const foot = document.createElement("div");
      foot.slot = "footer";
      foot.style.cssText = "display:flex;gap:8px;justify-content:flex-end;width:100%;";
      const yaml = document.createElement("ha-button");
      yaml.setAttribute("appearance", "plain");
      yaml.textContent = "YAML";
      yaml.style.marginRight = "auto";
      yaml.addEventListener("click", () => { ed.yamlMode = !ed.yamlMode; });
      const cancel = document.createElement("ha-button");
      cancel.setAttribute("appearance", "plain");
      cancel.textContent = "Abbrechen";
      const ok = document.createElement("ha-button");
      ok.textContent = "Übernehmen";
      foot.append(yaml, cancel, ok);
      dlg.appendChild(foot);

      const finish = (result) => {
        if (done) return;
        done = true;
        this._openEditor = null;
        dlg.open = false;
        setTimeout(() => dlg.remove(), 400);
        resolve(result);
      };
      cancel.addEventListener("click", () => finish(null));
      ok.addEventListener("click", () => finish(value));
      // Nur das Schließen des Dialogs selbst zählt (Auswahllisten darin feuern auch "closed").
      dlg.addEventListener("closed", (e) => { if (e.target === dlg) finish(null); });
      dlg.addEventListener("wa-after-hide", (e) => { if (e.target === dlg) finish(null); });

      this.appendChild(dlg);
      this._openEditor = ed;
      requestAnimationFrame(() => { dlg.open = true; });
    });
  }
}

if (!customElements.get("ha-blockly-automations-panel")) {
  customElements.define("ha-blockly-automations-panel", HaBlocklyAutomationsPanel);
}
