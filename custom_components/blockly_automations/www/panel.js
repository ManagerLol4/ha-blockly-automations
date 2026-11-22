// Seitenleisten-Panel: bettet den Editor als iframe ein (Blockly braucht
// globale Styles, die im Shadow-DOM von HA nicht ankommen) und reicht das
// hass-Objekt weiter. Gleicher Ursprung, also direkter Zugriff.
class HaBlocklyAutomationsPanel extends HTMLElement {
  constructor() {
    super();
    this._hass = null;
    this._panel = null;
    this._narrow = false;
    this._frame = null;
  }

  set hass(hass) {
    this._hass = hass;
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
    const v = cfg.version || "dev";
    this.style.cssText = "display:block;height:100%;";
    const frame = document.createElement("iframe");
    frame.src = `${base}/editor.html?v=${encodeURIComponent(v)}`;
    frame.style.cssText = "border:0;width:100%;height:100%;display:block;";
    frame.addEventListener("load", () => this._push());
    this.appendChild(frame);
    this._frame = frame;
    // Der Editor ruft das auf, um die HA-Seitenleiste ein-/auszuklappen.
    window.__haBlocklyToggleMenu = () =>
      this.dispatchEvent(
        new Event("hass-toggle-menu", { bubbles: true, composed: true })
      );
  }

  _push() {
    const w = this._frame && this._frame.contentWindow;
    if (w && w.haBlockly && this._hass) {
      w.haBlockly.setHass(this._hass, this._narrow);
    }
  }
}

if (!customElements.get("ha-blockly-automations-panel")) {
  customElements.define("ha-blockly-automations-panel", HaBlocklyAutomationsPanel);
}
