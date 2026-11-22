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
    // HA kann hass/panel/narrow setzen, bevor dieses Element (über den Lader
    // panel.js) definiert ist. Solche vorab gesetzten Werte hier übernehmen.
    for (const prop of ["panel", "narrow", "hass"]) {
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const value = this[prop];
        delete this[prop];
        this[prop] = value;
      }
    }
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
    window.__haBlocklyPick = (opts) => this._pick(opts);
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

  // ---------- Auswahlfenster für einzelne Optionen eines Bausteins ----------
  // opts: { mode: "entity" | "target" | "selector", title, value, selector, domains, label }
  // Ergebnis: { value } bei Übernahme (value "" = leeren), null bei Abbruch,
  // undefined wenn die HA-Bausteine nicht verfügbar sind.
  async _pick(opts) {
    if (!(await this._ensureComponents())) return undefined;
    if (opts.mode === "entity" || opts.mode === "target") {
      if (!(await this._ensureTargetTree())) return undefined;
      return this._pickEntity(opts);
    }
    if (!customElements.get("ha-selector")) return undefined;
    return this._pickSelector(opts);
  }

  // Der HA-Raumbaum (ha-automation-add-from-target) wird von HA erst mit dem
  // Dialog „… hinzufügen“ geladen. Einmal unsichtbar öffnen und sofort schließen.
  async _ensureTargetTree() {
    const TAG = "ha-automation-add-from-target";
    if (customElements.get(TAG)) return true;
    if (!this._treeLoading) {
      this._treeLoading = (async () => {
        const el = document.createElement("ha-automation-trigger");
        el.hass = this._hass;
        el.triggers = [];
        el.style.display = "none";
        el.addEventListener("value-changed", (e) => e.stopPropagation());
        this.appendChild(el);
        await new Promise((r) => setTimeout(r, 50));
        try { el._addTriggerDialog(); } catch (e) { el.remove(); return false; }
        const ha = document.querySelector("home-assistant");
        const t0 = Date.now();
        let d = null;
        while (Date.now() - t0 < 8000) {
          d = ha && ha.shadowRoot && ha.shadowRoot.querySelector("add-automation-element-dialog");
          if (d) d.style.visibility = "hidden";
          if (d && customElements.get(TAG)) break;
          await new Promise((r) => setTimeout(r, 20));
        }
        try { if (d && d.closeDialog) d.closeDialog(); } catch (e) { /* egal */ }
        setTimeout(() => el.remove(), 500);
        return !!customElements.get(TAG);
      })();
    }
    return this._treeLoading;
  }

  _makeDialog(title, wide) {
    const dlg = document.createElement("ha-dialog");
    dlg.headerTitle = title || "Auswählen";
    dlg.width = wide ? "large" : "medium";
    const foot = document.createElement("div");
    foot.slot = "footer";
    foot.style.cssText = "display:flex;gap:8px;justify-content:flex-end;width:100%;";
    dlg.appendChild(foot);
    return { dlg, foot };
  }

  _button(text, plain) {
    const b = document.createElement("ha-button");
    if (plain) b.setAttribute("appearance", "plain");
    b.textContent = text;
    return b;
  }

  _runDialog(dlg, setup) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (result) => {
        if (done) return;
        done = true;
        dlg.open = false;
        setTimeout(() => dlg.remove(), 400);
        resolve(result);
      };
      dlg.addEventListener("closed", (e) => { if (e.target === dlg) finish(null); });
      dlg.addEventListener("wa-after-hide", (e) => { if (e.target === dlg) finish(null); });
      setup(finish);
      this.appendChild(dlg);
      setTimeout(() => { dlg.open = true; }, 0);
    });
  }

  // Auswahl über ein HA-Auswahlfeld (Zustand, Uhrzeit, Dauer, Zahl, Liste …).
  _pickSelector(opts) {
    const { dlg, foot } = this._makeDialog(opts.title, false);
    let value = opts.value;
    const sel = document.createElement("ha-selector");
    sel.hass = this._hass;
    sel.selector = opts.selector;
    sel.value = value;
    sel.label = opts.label || "";
    sel.required = false;
    sel.style.cssText = "display:block;min-height:80px;";
    sel.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      value = e.detail ? e.detail.value : undefined;
      sel.value = value;
    });
    dlg.insertBefore(sel, foot);
    const clear = this._button("Leeren", true);
    clear.style.marginRight = "auto";
    const cancel = this._button("Abbrechen", true);
    const ok = this._button("Übernehmen");
    foot.append(clear, cancel, ok);
    return this._runDialog(dlg, (finish) => {
      clear.addEventListener("click", () => finish({ value: "" }));
      cancel.addEventListener("click", () => finish(null));
      ok.addEventListener("click", () => finish({ value: value === undefined ? "" : value }));
    });
  }

  // Entitäts-/Zielauswahl wie im HA-Dialog „… hinzufügen“:
  // Suche oben, links Bereiche/Geräte/Entitäten als Baum, rechts die Auswahl.
  _pickEntity(opts) {
    const hass = this._hass;
    const { dlg, foot } = this._makeDialog(opts.title, true);
    const domains = opts.domains && opts.domains.length ? opts.domains : null;
    const wrap = document.createElement("div");
    wrap.innerHTML = `
      <style>
        .hbp { display:flex; flex-direction:column; gap:12px; height:min(70vh,640px); }
        .hbp .cols { flex:1; display:flex; gap:16px; min-height:0; }
        .hbp .left { width:42%; min-width:220px; overflow:auto; border:1px solid var(--divider-color); border-radius:12px; }
        .hbp .right { flex:1; overflow:auto; background:var(--secondary-background-color, rgba(127,127,127,.06)); border-radius:12px; padding:6px; }
        .hbp .empty { height:100%; display:flex; align-items:center; justify-content:center; color:var(--secondary-text-color); }
        .hbp .head { font-size:13px; color:var(--secondary-text-color); padding:8px 10px 4px; }
        .hbp .row { display:flex; align-items:center; gap:12px; width:100%; padding:10px 12px; border:0; border-radius:10px;
          background:var(--card-background-color, transparent); color:var(--primary-text-color); text-align:left; cursor:pointer;
          margin:4px 0; font:inherit; border:1px solid var(--divider-color); }
        .hbp .row:hover { border-color: var(--primary-color); }
        .hbp .row.sel { border-color: var(--primary-color); background: rgba(3,169,244,.12); }
        .hbp .row .t { flex:1; min-width:0; }
        .hbp .row .n { font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .hbp .row .s { font-size:12px; color:var(--secondary-text-color); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .hbp .row.whole { font-weight:600; }
        .hbp input.q { width:100%; box-sizing:border-box; padding:12px 14px; border-radius:10px; border:1px solid var(--divider-color);
          background:var(--card-background-color, transparent); color:var(--primary-text-color); font:inherit; outline:none; }
        .hbp input.q:focus { border-color: var(--primary-color); }
      </style>
      <div class="hbp">
        <input class="q" type="search" placeholder="Durchsuchen">
        <div class="cols"><div class="left"></div><div class="right"><div class="empty">Wähle links einen Bereich, ein Gerät oder eine Entität</div></div></div>
      </div>`;
    dlg.insertBefore(wrap, foot);
    const left = wrap.querySelector(".left");
    const right = wrap.querySelector(".right");
    const q = wrap.querySelector(".q");

    const tree = document.createElement("ha-automation-add-from-target");
    tree.hass = hass;
    tree.states = hass.states;
    tree.narrow = false;
    tree.timeLocationGroups = [];
    const cur = typeof opts.value === "string" && opts.value ? { entity_id: opts.value } : undefined;
    if (cur) tree.value = cur;
    left.appendChild(tree);

    const ents = hass.entities || {};
    const devs = hass.devices || {};
    const areas = hass.areas || {};
    const areaOf = (eid) => {
      const e = ents[eid];
      if (!e) return null;
      return e.area_id || (e.device_id && devs[e.device_id] && devs[e.device_id].area_id) || null;
    };
    const okDomain = (eid) => !domains || domains.includes(eid.split(".")[0]);
    // Technische (Diagnose/Konfiguration) und versteckte Entitäten nur über die Suche.
    const everyday = (eid) => { const e = ents[eid]; return !e || (!e.entity_category && !e.hidden); };
    const nameOf = (eid) => (hass.states[eid] && hass.states[eid].attributes.friendly_name) || eid;
    const sortByName = (list) => list.sort((a, b) => nameOf(a).localeCompare(nameOf(b), "de"));
    const entitiesFor = (t) => {
      const all = Object.keys(hass.states).filter(okDomain).filter(everyday);
      if (t.entity_id) return [t.entity_id];
      if (t.device_id) return sortByName(all.filter((eid) => ents[eid] && ents[eid].device_id === t.device_id));
      if (t.area_id) return sortByName(all.filter((eid) => areaOf(eid) === t.area_id));
      if (t.floor_id) {
        const ids = Object.values(areas).filter((a) => a.floor_id === t.floor_id).map((a) => a.area_id);
        return sortByName(all.filter((eid) => ids.includes(areaOf(eid))));
      }
      if (t.label_id) return sortByName(all.filter((eid) => ents[eid] && (ents[eid].labels || []).includes(t.label_id)));
      return [];
    };
    const targetName = (t) => {
      if (t.area_id) return (areas[t.area_id] && areas[t.area_id].name) || t.area_id;
      if (t.device_id) return (devs[t.device_id] && (devs[t.device_id].name_by_user || devs[t.device_id].name)) || "Gerät";
      if (t.floor_id) return (hass.floors && hass.floors[t.floor_id] && hass.floors[t.floor_id].name) || t.floor_id;
      if (t.label_id) return t.label_id;
      return "";
    };

    let finishRef = null;
    const row = (eid) => {
      const b = document.createElement("button");
      b.className = "row" + (eid === opts.value ? " sel" : "");
      const icon = document.createElement("ha-state-icon");
      icon.hass = hass;
      icon.stateObj = hass.states[eid];
      const a = areaOf(eid);
      b.appendChild(icon);
      const t = document.createElement("div");
      t.className = "t";
      t.innerHTML = '<div class="n"></div><div class="s"></div>';
      t.querySelector(".n").textContent = nameOf(eid);
      t.querySelector(".s").textContent = [a && areas[a] ? areas[a].name : "", eid].filter(Boolean).join(" · ");
      b.appendChild(t);
      b.addEventListener("click", () => finishRef && finishRef({ value: opts.mode === "target" ? { entity_id: eid } : eid }));
      return b;
    };
    const show = (list, heading, whole) => {
      right.innerHTML = "";
      if (whole) {
        const w = document.createElement("button");
        w.className = "row whole";
        w.textContent = `➜ Ganz „${targetName(whole)}“ verwenden`;
        w.addEventListener("click", () => finishRef && finishRef({ value: whole }));
        right.appendChild(w);
      }
      if (!list.length) {
        const h = document.createElement("div");
        h.className = "head";
        h.textContent = "Hier gibt es nichts Passendes.";
        right.appendChild(h);
        return;
      }
      // Nach Art gruppieren (Licht, Schalter, Sensor …) wie in HA.
      const groups = new Map();
      for (const eid of list.slice(0, 400)) {
        const d = eid.split(".")[0];
        if (!groups.has(d)) groups.set(d, []);
        groups.get(d).push(eid);
      }
      const title = (d) => {
        try { return hass.localize(`component.${d}.title`) || hass.localize(`component.${d}.entity_component._.name`) || d; } catch (e) { return d; }
      };
      const sorted = [...groups.entries()].sort((a, b) => title(a[0]).localeCompare(title(b[0]), "de"));
      if (heading && sorted.length > 1) {
        const h0 = document.createElement("div");
        h0.className = "head";
        h0.textContent = heading;
        right.appendChild(h0);
      }
      for (const [d, eids] of sorted) {
        const h = document.createElement("div");
        h.className = "head";
        h.textContent = `${title(d)} (${eids.length})`;
        right.appendChild(h);
        for (const eid of eids) right.appendChild(row(eid));
      }
    };
    tree.addEventListener("value-changed", (e) => {
      e.stopPropagation();
      const t = (e.detail && e.detail.value) || {};
      tree.value = t;
      const isWhole = opts.mode === "target" && !t.entity_id && Object.values(t).some(Boolean);
      show(entitiesFor(t), "Entitäten", isWhole ? Object.fromEntries(Object.entries(t).filter(([, v]) => v)) : null);
    });
    tree.addEventListener("time-location-group-selected", (e) => e.stopPropagation());
    q.addEventListener("input", () => {
      const s = q.value.trim().toLowerCase();
      if (!s) { right.innerHTML = '<div class="empty">Wähle links einen Bereich, ein Gerät oder eine Entität</div>'; return; }
      const hits = sortByName(Object.keys(hass.states).filter(okDomain).filter((eid) => {
        const a = areaOf(eid);
        return eid.includes(s) || nameOf(eid).toLowerCase().includes(s) || (a && areas[a] && areas[a].name.toLowerCase().includes(s));
      }));
      show(hits, `Suchergebnisse (${hits.length})`);
    });
    if (typeof opts.value === "string" && opts.value) show([opts.value], "Aktuelle Auswahl");

    const clear = this._button("Leeren", true);
    clear.style.marginRight = "auto";
    const cancel = this._button("Abbrechen", true);
    foot.append(clear, cancel);
    return this._runDialog(dlg, (finish) => {
      finishRef = finish;
      clear.addEventListener("click", () => finish({ value: "" }));
      cancel.addEventListener("click", () => finish(null));
      setTimeout(() => q.focus(), 300);
    });
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
    await new Promise((r) => setTimeout(r, 50));
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
    // Warten, bis der Dialog offen war und wieder zu ist (HA entfernt ihn nach dem Schließen).
    let opened = false;
    const t0 = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 150));
      const d = dialog();
      const isOpen = !!(d && d.isConnected && (d.params || d._params) && !d._closing);
      if (isOpen) opened = true;
      if (opened && !isOpen) break;
      // Dialog nie gefunden (andere HA-Version): auf ein Ergebnis oder max. 10 Minuten warten.
      if (!opened && (added.length || Date.now() - t0 > 600000)) break;
      if (Date.now() - t0 > 3600000) break;
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
