/* solar-energy-compare-card.js v2
 * Home Assistant Lovelace Custom Card
 * Compares daily solar production and household energy use.
 * v2: adds กราฟ / รายการ tabs to match design mock.
 */

class SolarEnergyCompareCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._data = [];
    this._loading = false;
    this._error = null;
    this._selected = null;
    this._view = "chart"; // 'chart' | 'list'
    this._timer = null;
  }

  setConfig(config) {
    if (!config || !config.solar_entity || !config.usage_entity) {
      throw new Error("solar-energy-compare-card requires solar_entity and usage_entity");
    }
    this._config = {
      days: 15,
      title: "เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน",
      solar_label: "ผลิตไฟ",
      usage_label: "ใช้ไฟ",
      chart_label: "กราฟ",
      list_label: "รายการ",
      unit: "kWh",
      decimals: 1,
      history_hours: 24 * 17,
      aggregation: "delta",
      ...config,
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._loadedOnce) {
      this._loadedOnce = true;
      this._loadHistory();
    } else {
      const s = hass.states?.[this._config.solar_entity];
      const u = hass.states?.[this._config.usage_entity];
      const key = `${s?.state}|${u?.state}`;
      if (key !== this._lastStateKey) {
        this._lastStateKey = key;
        clearTimeout(this._timer);
        this._timer = setTimeout(() => this._loadHistory(), 1500);
      }
    }
  }

  getCardSize() { return 4; }

  async _loadHistory() {
    if (!this._hass || this._loading) return;
    this._loading = true;
    this._error = null;
    this._render();
    try {
      const now = new Date();
      const start = new Date(now.getTime() - this._config.history_hours * 3600 * 1000);
      const [solarHistory, usageHistory] = await Promise.all([
        this._history(this._config.solar_entity, start),
        this._history(this._config.usage_entity, start),
      ]);
      const days = this._buildDailyData(solarHistory, usageHistory);
      this._data = days.slice(-Number(this._config.days));
      if (this._data.length) {
        if (!this._selected || !this._data.some(d => d.date === this._selected)) {
          this._selected = this._data[this._data.length - 1].date;
        }
      }
    } catch (e) {
      console.error("[solar-energy-compare-card]", e);
      this._error = e?.message || String(e);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  _history(entityId, start) {
    return this._hass.callWS({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: new Date().toISOString(),
      entity_ids: [entityId],
      minimal_response: false,
      no_attributes: true,
      significant_changes_only: false,
    }).then(result => result?.[entityId] || []);
  }

  _buildDailyData(solar, usage) {
    const sN = this._normaliseHistory(solar);
    const uN = this._normaliseHistory(usage);
    const dates = new Set([...sN.map(x => x.date), ...uN.map(x => x.date)]);
    const sortedDates = [...dates].sort();
    return sortedDates.map(date => ({
      date,
      solar: this._safe(this._dailyValue(sN, date)),
      usage: this._safe(this._dailyValue(uN, date)),
    }));
  }

  _normaliseHistory(history) {
    return (history || [])
      .map(item => {
        const value = Number.parseFloat(item.state);
        const dt = new Date(item.last_changed || item.last_updated);
        return { value, dt, date: this._localDateKey(dt) };
      })
      .filter(x => Number.isFinite(x.value) && !Number.isNaN(x.dt.getTime()))
      .sort((a, b) => a.dt - b.dt);
  }

  _dailyValue(history, date) {
    const items = history.filter(x => x.date === date);
    if (!items.length) return 0;
    if (this._config.aggregation === "daily") {
      return items[items.length - 1].value;
    }
    let total = 0;
    let previous = null;
    for (const item of items) {
      if (previous !== null) {
        const diff = item.value - previous;
        if (diff >= 0) total += diff;
      }
      previous = item.value;
    }
    if (total > 0) return total;
    const first = items[0].value;
    const last = items[items.length - 1].value;
    return Math.max(0, last - first);
  }

  _localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  _safe(v) { return Number.isFinite(v) ? Math.max(0, v) : 0; }

  _fmt(v) {
    return Number(v || 0).toLocaleString("th-TH", {
      minimumFractionDigits: this._config.decimals,
      maximumFractionDigits: this._config.decimals,
    });
  }

  _dayLabel(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    const dt = new Date(y, m - 1, d);
    return {
      day: String(d),
      month: dt.toLocaleDateString("th-TH", { month: "short" }).replace(".", ""),
    };
  }

  _dateFull(dateKey) {
    const [y, m, d] = dateKey.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString("th-TH", {
      day: "numeric", month: "short", year: "numeric",
    });
  }

  _setView(view) {
    if (this._view === view) return;
    this._view = view;
    this._render();
  }

  _render() {
    if (!this.shadowRoot) return;
    const style = `<style>${this._css()}</style>`;

    if (this._loading) {
      this.shadowRoot.innerHTML = `${style}<ha-card><div class="loading">กำลังโหลดข้อมูล...</div></ha-card>`;
      return;
    }
    if (this._error) {
      this.shadowRoot.innerHTML = `${style}<ha-card><div class="error">โหลดข้อมูลไม่สำเร็จ<br><small>${this._esc(this._error)}</small></div></ha-card>`;
      return;
    }

    const data = this._data || [];
    const max = Math.max(1, ...data.flatMap(d => [d.solar, d.usage]));
    const selected = data.find(d => d.date === this._selected) || data[data.length - 1];
    const isChart = this._view === "chart";

    this.shadowRoot.innerHTML = `
      ${style}
      <ha-card>
        <div class="wrap">
          <div class="tabs" role="tablist">
            <button class="tab ${isChart ? "active" : ""}" data-view="chart" role="tab">${this._esc(this._config.chart_label)}</button>
            <button class="tab ${!isChart ? "active" : ""}" data-view="list" role="tab">${this._esc(this._config.list_label)}</button>
          </div>

          <div class="title">${this._esc(this._config.title)}</div>

          <div class="legend">
            <span><i class="dot solar"></i>${this._esc(this._config.solar_label)} (kWh)</span>
            <span><i class="dot usage"></i>${this._esc(this._config.usage_label)} (kWh)</span>
          </div>

          ${isChart ? `
            <div class="chart-wrap" id="chart">
              ${this._chartSvg(data, max)}
              <div class="tooltip" id="tooltip"></div>
            </div>
            ${selected ? `
              <div class="selected">
                <div class="selected-date">${this._dateFull(selected.date)}</div>
                <div class="selected-row">
                  <span><i class="dot solar"></i>${this._esc(this._config.solar_label)}</span>
                  <strong>${this._fmt(selected.solar)} kWh</strong>
                </div>
                <div class="selected-row">
                  <span><i class="dot usage"></i>${this._esc(this._config.usage_label)}</span>
                  <strong>${this._fmt(selected.usage)} kWh</strong>
                </div>
              </div>
            ` : ""}
          ` : `
            <div class="list-wrap" id="list">
              ${this._listHtml(data)}
            </div>
          `}
        </div>
      </ha-card>
    `;
    this._bindEvents();
  }

  _listHtml(data) {
    if (!data.length) return `<div class="empty">ยังไม่มีข้อมูลย้อนหลัง</div>`;
    const rows = [...data].reverse(); // newest first
    const max = Math.max(1, ...data.flatMap(d => [d.solar, d.usage]));
    return rows.map(d => {
      const label = this._dayLabel(d.date);
      const full = this._dateFull(d.date);
      const active = d.date === this._selected ? " active" : "";
      const sPct = Math.max(2, (d.solar / max) * 100);
      const uPct = Math.max(2, (d.usage / max) * 100);
      return `
        <div class="list-row${active}" data-date="${d.date}" title="${this._esc(full)}">
          <div class="list-date"><b>${label.day}</b><span>${this._esc(label.month)}</span></div>
          <div class="list-mid">
            <div class="list-bar-row">
              <i class="dot solar"></i>
              <div class="mini-track"><div class="mini-fill solar" style="width:${sPct.toFixed(1)}%"></div></div>
              <span class="list-val">${this._fmt(d.solar)}</span>
            </div>
            <div class="list-bar-row">
              <i class="dot usage"></i>
              <div class="mini-track"><div class="mini-fill usage" style="width:${uPct.toFixed(1)}%"></div></div>
              <span class="list-val">${this._fmt(d.usage)}</span>
            </div>
          </div>
          <div class="list-unit">kWh</div>
        </div>
      `;
    }).join("");
  }

  _chartSvg(data, max) {
    if (!data.length) return `<div class="empty">ยังไม่มีข้อมูลย้อนหลัง</div>`;
    const W = 700, H = 245;
    const padL = 35, padR = 8, padT = 10, padB = 42;
    const chartW = W - padL - padR;
    const chartH = H - padT - padB;
    const groupW = chartW / data.length;
    const gap = Math.min(5, groupW * 0.10);
    const barW = Math.max(3, (groupW - gap * 3) / 2);
    const baseY = padT + chartH;

    let svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg"
           role="img" aria-label="กราฟเปรียบเทียบการผลิตไฟและการใช้ไฟย้อนหลัง">
        <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${baseY}" class="axis"/>
        <line x1="${padL}" y1="${baseY}" x2="${W-padR}" y2="${baseY}" class="axis"/>
    `;
    for (let i = 0; i <= 4; i++) {
      const value = max * (i / 4);
      const y = baseY - chartH * (i / 4);
      svg += `
        <line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" class="grid"/>
        <text x="${padL - 7}" y="${y + 4}" text-anchor="end" class="y-label">${this._fmt(value).replace(/,0$/, "")}</text>
      `;
    }
    data.forEach((d, i) => {
      const center = padL + groupW * i + groupW / 2;
      const solarH = chartH * (d.solar / max);
      const usageH = chartH * (d.usage / max);
      const solarX = center - barW - gap / 2;
      const usageX = center + gap / 2;
      const solarY = baseY - solarH;
      const usageY = baseY - usageH;
      const active = d.date === this._selected ? " active" : "";
      const label = this._dayLabel(d.date);
      svg += `
        <g class="day-group${active}" data-date="${d.date}">
          <rect class="hit" x="${padL + groupW*i}" y="${padT}" width="${groupW}" height="${chartH + padB}" rx="4"/>
          <rect class="bar solar-bar" x="${solarX}" y="${solarY}" width="${barW}" height="${Math.max(1, solarH)}" rx="2"/>
          <rect class="bar usage-bar" x="${usageX}" y="${usageY}" width="${barW}" height="${Math.max(1, usageH)}" rx="2"/>
          <text x="${center}" y="${baseY + 17}" text-anchor="middle" class="x-day">${label.day}</text>
          <text x="${center}" y="${baseY + 31}" text-anchor="middle" class="x-month">${label.month}</text>
        </g>
      `;
    });
    svg += `</svg>`;
    return svg;
  }

  _bindEvents() {
    this.shadowRoot.querySelectorAll(".tab").forEach(btn => {
      btn.addEventListener("click", () => this._setView(btn.dataset.view));
    });

    if (this._view === "list") {
      this.shadowRoot.querySelectorAll(".list-row").forEach(row => {
        row.addEventListener("click", () => {
          this._selected = row.dataset.date;
          this._render();
        });
      });
      return;
    }

    const chart = this.shadowRoot.querySelector("#chart");
    const tooltip = this.shadowRoot.querySelector("#tooltip");
    if (!chart || !tooltip) return;

    const show = (date, event) => {
      const d = this._data.find(x => x.date === date);
      if (!d) return;
      this._selected = date;
      // re-render to update highlight + selected panel, then show tooltip
      this._render();
      const newChart = this.shadowRoot.querySelector("#chart");
      const newTooltip = this.shadowRoot.querySelector("#tooltip");
      if (!newChart || !newTooltip) return;
      const rect = newChart.getBoundingClientRect();
      const x = (event?.clientX ?? rect.left + rect.width / 2) - rect.left;
      const y = (event?.clientY ?? rect.top + 20) - rect.top;
      newTooltip.innerHTML = `
        <div class="tip-date">${this._dateFull(d.date)}</div>
        <div><i class="dot solar"></i>โซลาร์เซลล์ <b>${this._fmt(d.solar)} kWh</b></div>
        <div><i class="dot usage"></i>ใช้ไฟ <b>${this._fmt(d.usage)} kWh</b></div>
      `;
      newTooltip.classList.add("show");
      const tw = 170;
      let left = x - tw / 2;
      left = Math.max(4, Math.min(rect.width - tw - 4, left));
      newTooltip.style.left = `${left}px`;
      newTooltip.style.top = `${Math.max(4, y - 78)}px`;
    };

    this.shadowRoot.querySelectorAll(".day-group").forEach(group => {
      group.addEventListener("pointerenter", e => show(group.dataset.date, e));
      group.addEventListener("pointermove", e => {
        const tt = this.shadowRoot.querySelector("#tooltip");
        if (!tt?.classList.contains("show")) return;
        const rect = chart.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const tw = 170;
        tt.style.left = `${Math.max(4, Math.min(rect.width - tw - 4, x - tw / 2))}px`;
      });
      group.addEventListener("pointerleave", () => {
        const tt = this.shadowRoot.querySelector("#tooltip");
        if (tt) tt.classList.remove("show");
      });
      group.addEventListener("click", e => show(group.dataset.date, e));
      group.addEventListener("touchstart", e => {
        show(group.dataset.date, e.touches[0]);
      }, { passive: true });
    });
  }

  _esc(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;").replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;").replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  _css() {
    return `
      :host { display:block; --solar-color:#ffbd32; --usage-color:#2389ff;
        --card-bg:#071d31; --text:#f5f7fb; --muted:#91a2b6; }
      ha-card { overflow:hidden; border-radius:16px; background:var(--card-bg);
        color:var(--text); border:1px solid rgba(72,150,220,.30); box-shadow:none; }
      .wrap { padding:14px 14px 13px; position:relative; }

      /* Tabs - match mock */
      .tabs { display:flex; background:rgba(20,45,70,.85); border-radius:12px;
        padding:4px; margin-bottom:14px; gap:4px; }
      .tab { flex:1; border:0; border-radius:9px; padding:9px 0; font-size:14px;
        font-weight:600; background:transparent; color:#8ea3b8; cursor:pointer;
        transition:background .15s ease, color .15s ease; }
      .tab.active { background:#1f7ae0; color:#fff; box-shadow:0 2px 8px rgba(31,122,224,.45); }
      .tab:not(.active):hover { color:#c9d8e8; }

      .title { font-size:17px; line-height:1.25; font-weight:700; margin:0 0 14px; }
      .legend { display:flex; gap:22px; align-items:center; flex-wrap:wrap;
        color:#dbe6f2; font-size:13px; margin-bottom:8px; }
      .dot { display:inline-block; width:11px; height:11px; border-radius:50%;
        margin-right:8px; vertical-align:-1px; }
      .dot.solar { background:var(--solar-color); }
      .dot.usage { background:var(--usage-color); }

      .chart-wrap { position:relative; width:100%; height:245px; touch-action:pan-y; }
      .chart-svg { display:block; width:100%; height:100%; overflow:visible; }
      .grid { stroke:rgba(185,207,230,.13); stroke-width:1; vector-effect:non-scaling-stroke; }
      .axis { stroke:rgba(185,207,230,.20); stroke-width:1; vector-effect:non-scaling-stroke; }
      .y-label { fill:#9aabba; font-size:11px; }
      .x-day { fill:#e1e9f2; font-size:11px; font-weight:500; }
      .x-month { fill:#8294a8; font-size:10px; }
      .bar { vector-effect:non-scaling-stroke; }
      .solar-bar { fill:var(--solar-color); }
      .usage-bar { fill:var(--usage-color); }
      .hit { fill:transparent; cursor:pointer; }
      .day-group.active .hit { fill:rgba(42,137,255,.10); stroke:rgba(42,137,255,.50); stroke-width:1; }
      .day-group.active .solar-bar, .day-group.active .usage-bar { filter:brightness(1.12); }

      .tooltip { position:absolute; z-index:10; width:170px; box-sizing:border-box;
        padding:10px 11px; border-radius:11px; background:rgba(8,25,42,.97);
        border:1px solid rgba(100,170,235,.38); box-shadow:0 8px 24px rgba(0,0,0,.35);
        color:#f4f7fb; font-size:12px; line-height:1.8; pointer-events:none;
        opacity:0; transform:translateY(4px); transition:opacity .12s ease, transform .12s ease; }
      .tooltip.show { opacity:1; transform:translateY(0); }
      .tooltip .dot { width:8px; height:8px; margin-right:5px; }
      .tip-date { font-weight:700; margin-bottom:2px; color:#fff; }

      /* List view */
      .list-wrap { display:flex; flex-direction:column; gap:6px; max-height:320px; overflow-y:auto;
        padding-right:2px; }
      .list-row { display:flex; align-items:center; gap:12px; padding:9px 10px;
        border-radius:11px; background:rgba(255,255,255,.03);
        border:1px solid rgba(120,170,220,.10); cursor:pointer;
        transition:background .12s ease, border-color .12s ease; }
      .list-row:hover { background:rgba(60,130,200,.10); }
      .list-row.active { background:rgba(42,137,255,.12); border-color:rgba(42,137,255,.45); }
      .list-date { display:flex; flex-direction:column; align-items:center; min-width:38px; }
      .list-date b { font-size:16px; line-height:1; }
      .list-date span { font-size:11px; color:#8294a8; }
      .list-mid { flex:1; display:flex; flex-direction:column; gap:5px; }
      .list-bar-row { display:flex; align-items:center; gap:7px; }
      .list-bar-row .dot { width:8px; height:8px; margin:0; flex-shrink:0; }
      .mini-track { flex:1; height:6px; border-radius:4px; background:rgba(255,255,255,.08); overflow:hidden; }
      .mini-fill { height:100%; border-radius:4px; }
      .mini-fill.solar { background:var(--solar-color); }
      .mini-fill.usage { background:var(--usage-color); }
      .list-val { font-size:12.5px; min-width:52px; text-align:right; font-variant-numeric:tabular-nums; }
      .list-unit { font-size:11px; color:#8294a8; }

      .selected { margin-top:5px; padding-top:10px; border-top:1px solid rgba(180,205,230,.12); }
      .selected-date { font-size:12px; color:#91a2b6; margin-bottom:5px; }
      .selected-row { display:flex; justify-content:space-between; align-items:center;
        min-height:27px; font-size:13px; }
      .selected-row strong { font-size:14px; }

      .loading, .error, .empty { padding:24px 16px; text-align:center; color:#9aabba; font-size:13px; }
      .error { color:#ff9b9b; }

      @media (max-width: 480px) {
        .wrap { padding:12px 12px 10px; }
        .title { font-size:16px; margin-bottom:12px; }
        .legend { font-size:12px; gap:15px; }
        .chart-wrap { height:225px; }
        .tab { font-size:13px; padding:8px 0; }
      }
    `;
  }
}

customElements.define("solar-energy-compare-card", SolarEnergyCompareCard);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "solar-energy-compare-card",
  name: "Solar Energy Compare Card",
  description: "Solar vs home usage chart with กราฟ/รายการ tabs, hover/touch tooltip.",
  preview: true,
});
