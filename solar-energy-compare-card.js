/* solar-energy-compare-card.js v5
 * Home Assistant Lovelace Custom Card
 * Compares daily solar production and household energy use.
 * v2: adds กราฟ / รายการ tabs to match design mock.
 */

class SolarEnergyCompareCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._data = [];
    this._loading = true;
    this._error = null;
    this._selected = null;
    this._lastStateKey = null;
    this._loadedOnce = false;
    this._configMissing = false;
    this._configTimer = null;
    this._refreshTimer = null;
    this._lastFetch = 0;
    this._view = "chart";
  }

  static getConfigElement() {
    return document.createElement("solar-energy-compare-card-editor");
  }

  static getStubConfig() {
    return {
      solar_entity: "",
      usage_entity: "",
      title: "เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน",
      solar_label: "ผลิตไฟ",
      usage_label: "ใช้ไฟ",
      chart_label: "กราฟ",
      list_label: "รายการ",
      days: 15,
      decimals: 1,
      aggregation: "delta",
    };
  }

  setConfig(config) {
    const prevEntities = this._config
      ? `${this._config.solar_entity}|${this._config.usage_entity}|${this._config.days}|${this._config.aggregation}`
      : null;
    const wasMissing = this._configMissing;
    this._config = {
      title: "เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน",
      solar_label: "ผลิตไฟ",
      usage_label: "ใช้ไฟ",
      chart_label: "กราฟ",
      list_label: "รายการ",
      days: 15,
      decimals: 1,
      aggregation: "delta",
      ...config,
    };
    // Don't throw while the user is still picking entities in the visual
    // editor — show a friendly placeholder instead.
    this._configMissing = !(this._config.solar_entity && this._config.usage_entity);
    const newEntities = `${this._config.solar_entity}|${this._config.usage_entity}|${this._config.days}|${this._config.aggregation}`;
    // Fetch history when entities become valid or change
    if (!this._configMissing && this._hass) {
      if (wasMissing || !this._loadedOnce || prevEntities !== newEntities) {
        this._loadedOnce = true;
        clearTimeout(this._configTimer);
        this._configTimer = setTimeout(() => this._loadHistory(), 300);
      }
    }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (this._configMissing) return;
    if (!this._loadedOnce) {
      this._loadedOnce = true;
      this._loadHistory();
      return;
    }
    if (this._config) {
      const s = hass.states?.[this._config.solar_entity];
      const u = hass.states?.[this._config.usage_entity];
      const key = `${s?.state}|${u?.state}`;
      if (key === this._lastStateKey) return;
      this._lastStateKey = key;
      // Throttle background refresh: at most once every 5 minutes so the
      // chart never blinks while data is being refreshed.
      if (this._refreshTimer) return;
      const elapsed = Date.now() - (this._lastFetch || 0);
      const delay = elapsed >= 5 * 60 * 1000 ? 2000 : 5 * 60 * 1000 - elapsed;
      this._refreshTimer = setTimeout(() => {
        this._refreshTimer = null;
        this._loadHistory();
      }, delay);
    }
  }

  getCardSize() {
    return this._view === "list" ? 6 : 5;
  }

  async _loadHistory() {
    if (!this._hass || this._loading || this._configMissing) return;
    // Only show the loading skeleton on the very first load. Background
    // refreshes keep the existing chart visible so nothing blinks.
    const firstLoad = this._data.length === 0;
    this._loading = true;
    this._error = null;
    this._lastFetch = Date.now();
    if (firstLoad) this._render();
    try {
      const days = Number(this._config.days) || 15;
      // Buffer days so "last reading of previous day" deltas work.
      const hours = (days + 3) * 24;
      const [solarHist, usageHist] = await Promise.all([
        this._fetchHistory(this._config.solar_entity, hours),
        this._fetchHistory(this._config.usage_entity, hours),
      ]);
      let data = this._buildDaily(
        solarHist, usageHist, days, this._config.aggregation
      );
      if (!data.length) {
        // Fallback: long-term statistics (survives recorder purge).
        const [solarStats, usageStats] = await Promise.all([
          this._fetchStatistics(this._config.solar_entity, days),
          this._fetchStatistics(this._config.usage_entity, days),
        ]);
        data = this._buildDailyFromStats(solarStats, usageStats, days);
      }
      console.info(
        `[solar-energy-compare-card] history points: solar=${solarHist.length}, usage=${usageHist.length} | daily rows=${data.length}`
      );
      if (!data.length) {
        console.warn(
          "[solar-energy-compare-card] No data from recorder history or long-term statistics. " +
          "Check that the entities are recorded (recorder include/exclude) and have statistics."
        );
      }
      this._data = data;
      if (data.length) {
        if (!this._selected || !data.some(d => d.date === this._selected)) {
          this._selected = data[data.length - 1].date;
        }
      }
    } catch (err) {
      console.error("[solar-energy-compare-card] load failed:", err);
      this._error = err?.message || String(err);
    } finally {
      this._loading = false;
      this._render();
    }
  }

  async _fetchHistory(entityId, hours) {
    const end = new Date();
    const start = new Date(end.getTime() - hours * 3600 * 1000);
    const url =
      `/api/history/period/${start.toISOString()}?` +
      `filter_entity_id=${encodeURIComponent(entityId)}&end_time=${encodeURIComponent(end.toISOString())}&minimal_response`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this._getToken()}` },
    });
    if (!res.ok) throw new Error(`history HTTP ${res.status}`);
    const json = await res.json();
    // HA returns an array of arrays (one per entity); be defensive.
    const flat = Array.isArray(json) ? json.flat() : [];
    return flat
      .map(r => ({
        t: this._parseTime(r),
        v: Number(r.state ?? r.s),
      }))
      .filter(p => Number.isFinite(p.t) && Number.isFinite(p.v))
      .sort((a, b) => a.t - b.t);
  }

  _parseTime(r) {
    const raw = r.last_changed ?? r.lc ?? r.last_updated ?? r.lu ?? r.t;
    if (typeof raw === "number") return raw < 1e12 ? raw * 1000 : raw;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : NaN;
  }

  async _fetchStatistics(entityId, days) {
    const end = new Date();
    end.setHours(23, 59, 59, 999);
    const start = new Date(end);
    start.setDate(start.getDate() - (days - 1));
    start.setHours(0, 0, 0, 0);
    const msg = {
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      statistic_ids: [entityId],
      period: "day",
      units: { energy: "kWh" },
    };
    const res = await this._hass.callWS(msg);
    const rows = res?.[entityId] || [];
    return rows.map(r => {
      const startTs = Date.parse(r.start);
      const change = Number(r.change);
      let value;
      if (Number.isFinite(change)) value = change;
      else if (Number.isFinite(Number(r.sum)) && Number.isFinite(Number(r.mean))) value = Number(r.sum);
      else value = Number(r.state);
      return { t: startTs, v: value };
    }).filter(p => Number.isFinite(p.t) && Number.isFinite(p.v));
  }

  _getToken() {
    // Prefer the hass connection auth; fallback to localStorage (frontend).
    try {
      const conn = this._hass?.connection;
      const token = conn?.options?.auth?.data?.access_token;
      if (token) return token;
    } catch { /* ignore */ }
    try {
      const raw = localStorage.getItem("hassTokens");
      if (raw) return JSON.parse(raw).access_token || "";
    } catch { /* ignore */ }
    return "";
  }

  _dayKey(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  _buildDaily(solarHist, usageHist, days, aggregation) {
    const groupByDay = (hist) => {
      const map = new Map();
      for (const p of hist) {
        const k = this._dayKey(p.t);
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(p);
      }
      return map;
    };
    const solarByDay = groupByDay(solarHist);
    const usageByDay = groupByDay(usageHist);

    const lastOf = (arr) => arr[arr.length - 1].v;
    const firstOf = (arr) => arr[0].v;

    const keys = [];
    const today = new Date();
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      keys.push(this._dayKey(d.getTime()));
    }
    // Include one extra previous day so sparse sensors (e.g. one reading
    // per day) still produce a delta for the first visible day.
    const prevKey = (() => {
      const d = new Date(today);
      d.setDate(d.getDate() - days);
      return this._dayKey(d.getTime());
    })();

    const deltaFor = (byDay, key, prevK) => {
      const cur = byDay.get(key);
      const prev = byDay.get(prevK);
      if (!cur || !cur.length) return 0;
      if (prev && prev.length) {
        const delta = lastOf(cur) - lastOf(prev);
        return delta >= 0 ? delta : Math.max(0, lastOf(cur)); // counter reset
      }
      // Fallback: intra-day delta when there is no previous-day reading.
      const delta = lastOf(cur) - firstOf(cur);
      return delta > 0 ? delta : 0;
    };
    const dailyValueFor = (byDay, key) => {
      const cur = byDay.get(key);
      if (!cur || !cur.length) return 0;
      return Math.max(0, lastOf(cur));
    };

    return keys.map((key, idx) => {
      const prevK = idx === 0 ? prevKey : keys[idx - 1];
      const solar = aggregation === "daily"
        ? dailyValueFor(solarByDay, key)
        : deltaFor(solarByDay, key, prevK);
      const usage = aggregation === "daily"
        ? dailyValueFor(usageByDay, key)
        : deltaFor(usageByDay, key, prevK);
      return { date: key, solar, usage };
    });
  }

  _buildDailyFromStats(solarStats, usageStats, days) {
    const toMap = (stats) => {
      const map = new Map();
      for (const p of stats) map.set(this._dayKey(p.t), p.v);
      return map;
    };
    const sMap = toMap(solarStats);
    const uMap = toMap(usageStats);
    const today = new Date();
    const out = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = this._dayKey(d.getTime());
      out.push({
        date: key,
        solar: Math.max(0, sMap.get(key) || 0),
        usage: Math.max(0, uMap.get(key) || 0),
      });
    }
    // Drop leading all-zero days that are just "no data yet".
    let first = out.findIndex(r => r.solar > 0 || r.usage > 0);
    if (first === -1) return [];
    return out.slice(first);
  }

  _setView(view) {
    if (this._view === view) return;
    this._view = view;
    this._render();
  }

  _render() {
    const style = `<style>${this._css()}</style>`;
    if (!this.shadowRoot) return;
    if (this._configMissing) {
      this.shadowRoot.innerHTML = `${style}<ha-card><div class="empty">กรุณาเลือก entity สำหรับการผลิตไฟและการใช้ไฟ<br><small>เปิด Visual editor แล้วเลือก entity ทั้งสองช่อง</small></div></ha-card>`;
      return;
    }
    if (this._loading && this._data.length === 0) {
      this.shadowRoot.innerHTML = `${style}<ha-card><div class="loading">กำลังโหลดข้อมูล...</div></ha-card>`;
      return;
    }
    if (this._error) {
      this.shadowRoot.innerHTML = `${style}<ha-card><div class="error">โหลดข้อมูลไม่สำเร็จ<br><small>${this._esc(this._error)}</small></div></ha-card>`;
      return;
    }

    const data = this._data || [];
    const max = Math.max(1, ...data.flatMap(d => [d.solar, d.usage]));
    const isChart = this._view === "chart";
    const yTicks = [0, 1, 2, 3, 4].map(i => max * i / 4);

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
            <div class="chart-wrap">
              <div class="chart-body">
                <div class="y-axis">
                  ${yTicks.map((v, i) => `<span style="bottom:${i * 25}%">${this._fmtTick(v)}</span>`).join("")}
                </div>
                <div class="plot" id="plot">
                  ${this._chartSvg(data, max)}
                  <div class="tooltip" id="tooltip"></div>
                </div>
              </div>
              <div class="x-axis">
                ${data.map(d => {
                  const l = this._dayLabel(d.date);
                  return `<div class="x-col"><b>${l.day}</b><span>${this._esc(l.month)}</span></div>`;
                }).join("")}
              </div>
            </div>
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
    if (!data.length) return `<div class="empty">ยังไม่มีข้อมูลย้อนหลัง<br><small>ตรวจสอบว่า entity_id ถูกต้อง และ sensor ถูกบันทึกใน recorder หรือมี long-term statistics<br>ดูรายละเอียดใน browser console (F12)</small></div>`;
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
    if (!data.length) return `<div class="empty">ยังไม่มีข้อมูลย้อนหลัง<br><small>ตรวจสอบว่า entity_id ถูกต้อง และ sensor ถูกบันทึกใน recorder หรือมี long-term statistics<br>ดูรายละเอียดใน browser console (F12)</small></div>`;
    // No text inside the SVG: axis labels are HTML so the browser renders
    // them in the system font without non-uniform stretching.
    const W = 700, H = 200;
    const groupW = W / data.length;
    const gap = Math.min(5, groupW * 0.10);
    const barW = Math.max(3, (groupW - gap * 3) / 2);

    let svg = `
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="chart-svg"
           role="img" aria-label="กราฟเปรียบเทียบการผลิตไฟและการใช้ไฟย้อนหลัง">
    `;
    for (let i = 0; i <= 4; i++) {
      const y = H - H * (i / 4);
      svg += `<line x1="0" y1="${y}" x2="${W}" y2="${y}" class="grid"/>`;
    }
    data.forEach((d, i) => {
      const center = groupW * i + groupW / 2;
      const solarH = H * (d.solar / max);
      const usageH = H * (d.usage / max);
      const solarX = center - barW - gap / 2;
      const usageX = center + gap / 2;
      const solarY = H - solarH;
      const usageY = H - usageH;
      const active = d.date === this._selected ? " active" : "";
      svg += `
        <g class="day-group${active}" data-date="${d.date}">
          <rect class="hit" x="${groupW*i}" y="0" width="${groupW}" height="${H}" rx="4"/>
          <rect class="bar solar-bar" x="${solarX.toFixed(1)}" y="${solarY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, solarH).toFixed(1)}" rx="2"/>
          <rect class="bar usage-bar" x="${usageX.toFixed(1)}" y="${usageY.toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1.5, usageH).toFixed(1)}" rx="2"/>
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

    const plot = this.shadowRoot.querySelector("#plot");
    const tooltip = this.shadowRoot.querySelector("#tooltip");
    if (!plot || !tooltip) return;

    // Hover shows a popup tooltip only — no full re-render, so the chart
    // never blinks while hovering.
    const show = (date, event) => {
      const d = this._data.find(x => x.date === date);
      if (!d) return;
      this._selected = date;
      this.shadowRoot.querySelectorAll(".day-group").forEach(g =>
        g.classList.toggle("active", g.dataset.date === date));
      const rect = plot.getBoundingClientRect();
      const x = (event?.clientX ?? rect.left + rect.width / 2) - rect.left;
      const y = (event?.clientY ?? rect.top + 20) - rect.top;
      tooltip.innerHTML = `
        <div class="tip-date">${this._dateFull(d.date)}</div>
        <div><i class="dot solar"></i>${this._esc(this._config.solar_label)} <b>${this._fmt(d.solar)} kWh</b></div>
        <div><i class="dot usage"></i>${this._esc(this._config.usage_label)} <b>${this._fmt(d.usage)} kWh</b></div>
      `;
      tooltip.classList.add("show");
      const tw = 170;
      let left = x - tw / 2;
      left = Math.max(4, Math.min(rect.width - tw - 4, left));
      tooltip.style.left = `${left}px`;
      tooltip.style.top = `${Math.max(4, y - 78)}px`;
    };

    this.shadowRoot.querySelectorAll(".day-group").forEach(group => {
      group.addEventListener("pointerenter", e => show(group.dataset.date, e));
      group.addEventListener("pointermove", e => {
        const tt = this.shadowRoot.querySelector("#tooltip");
        if (!tt?.classList.contains("show")) return;
        const rect = plot.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const tw = 170;
        tt.style.left = `${Math.max(4, Math.min(rect.width - tw - 4, x - tw / 2))}px`;
      });
      group.addEventListener("pointerleave", () => {
        tooltip.classList.remove("show");
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
      :host { display:block; --solar-color:#ffbd32; --usage-color:#2389ff; }
      /* No background override: the card uses the app/theme background.
         Text colors follow Home Assistant theme variables. */
      ha-card { overflow:hidden; border-radius:16px;
        color:var(--primary-text-color, #212121); }
      .wrap { padding:12px 12px 10px; position:relative; }

      /* Tabs */
      .tabs { display:flex; background:rgba(127,127,127,.18); border-radius:12px;
        padding:4px; margin-bottom:10px; gap:4px; }
      .tab { flex:1; border:0; border-radius:9px; padding:7px 0; font-size:13px;
        font-weight:600; background:transparent;
        color:var(--secondary-text-color, #727272); cursor:pointer;
        transition:background .15s ease, color .15s ease; }
      .tab.active { background:var(--primary-color, #1f7ae0);
        color:var(--text-primary-color, #fff);
        box-shadow:0 2px 8px rgba(0,0,0,.25); }

      .title { font-size:15px; line-height:1.25; font-weight:700; margin:0 0 8px; }
      .legend { display:flex; gap:18px; align-items:center; flex-wrap:wrap;
        font-size:12px; margin-bottom:6px;
        color:var(--secondary-text-color, #727272); }
      .dot { display:inline-block; width:10px; height:10px; border-radius:50%;
        margin-right:7px; vertical-align:-1px; }
      .dot.solar { background:var(--solar-color); }
      .dot.usage { background:var(--usage-color); }

      /* Chart: bars+gridlines are SVG, axis labels are plain HTML so the
         browser renders them in the system font with no distortion. */
      .chart-wrap { width:100%; touch-action:pan-y; }
      .chart-body { display:flex; height:160px; }
      .y-axis { position:relative; width:36px; flex-shrink:0; }
      .y-axis span { position:absolute; right:6px; transform:translateY(50%);
        font-size:11px; line-height:1; white-space:nowrap;
        color:var(--secondary-text-color, #727272);
        font-variant-numeric:tabular-nums; }
      .plot { flex:1; position:relative; min-width:0; }
      .chart-svg { display:block; width:100%; height:100%; }
      .grid { stroke:var(--divider-color, rgba(127,127,127,.35)); stroke-width:1; }
      .bar { }
      .solar-bar { fill:var(--solar-color); }
      .usage-bar { fill:var(--usage-color); }
      .hit { fill:transparent; cursor:pointer; }
      .day-group.active .hit { fill:rgba(42,137,255,.10); stroke:rgba(42,137,255,.50); stroke-width:1; }
      .day-group.active .solar-bar, .day-group.active .usage-bar { filter:brightness(1.08); }
      .x-axis { display:flex; margin-left:36px; margin-top:5px; }
      .x-col { flex:1; min-width:0; text-align:center; }
      .x-col b { display:block; font-size:11px; font-weight:500; line-height:1.3;
        font-variant-numeric:tabular-nums; }
      .x-col span { display:block; font-size:10px; line-height:1.3;
        color:var(--secondary-text-color, #727272); white-space:nowrap;
        overflow:hidden; text-overflow:ellipsis; }

      .tooltip { position:absolute; z-index:10; width:170px; box-sizing:border-box;
        padding:9px 11px; border-radius:11px;
        background:var(--card-background-color, #fff);
        border:1px solid var(--divider-color, rgba(127,127,127,.4));
        box-shadow:0 8px 24px rgba(0,0,0,.25);
        color:var(--primary-text-color, #212121); font-size:12px; line-height:1.8;
        pointer-events:none; opacity:0; transform:translateY(4px);
        transition:opacity .12s ease, transform .12s ease; }
      .tooltip.show { opacity:1; transform:translateY(0); }
      .tooltip .dot { width:8px; height:8px; margin-right:5px; }
      .tip-date { font-weight:700; margin-bottom:2px; }

      /* List view */
      .list-wrap { display:flex; flex-direction:column; gap:6px; max-height:300px; overflow-y:auto;
        padding-right:2px; }
      .list-row { display:flex; align-items:center; gap:12px; padding:8px 10px;
        border-radius:11px; background:rgba(127,127,127,.08);
        border:1px solid var(--divider-color, rgba(127,127,127,.25)); cursor:pointer;
        transition:background .12s ease, border-color .12s ease; }
      .list-row:hover { background:rgba(127,127,127,.16); }
      .list-row.active { border-color:var(--primary-color, #1f7ae0); }
      .list-date { display:flex; flex-direction:column; align-items:center; min-width:36px; }
      .list-date b { font-size:15px; line-height:1; }
      .list-date span { font-size:11px; color:var(--secondary-text-color, #727272); }
      .list-mid { flex:1; display:flex; flex-direction:column; gap:5px; }
      .list-bar-row { display:flex; align-items:center; gap:7px; }
      .list-bar-row .dot { width:8px; height:8px; margin:0; flex-shrink:0; }
      .mini-track { flex:1; height:6px; border-radius:4px;
        background:rgba(127,127,127,.20); overflow:hidden; }
      .mini-fill { height:100%; border-radius:4px; }
      .mini-fill.solar { background:var(--solar-color); }
      .mini-fill.usage { background:var(--usage-color); }
      .list-val { font-size:12px; min-width:52px; text-align:right; font-variant-numeric:tabular-nums; }
      .list-unit { font-size:11px; color:var(--secondary-text-color, #727272); }

      .loading, .error, .empty { padding:24px 16px; text-align:center;
        color:var(--secondary-text-color, #727272); font-size:13px; }
      .error { color:var(--error-color, #db4437); }

      @media (max-width: 480px) {
        .wrap { padding:10px 10px 8px; }
        .chart-body { height:140px; }
      }
    `;
  }

  _fmt(v) {
    return Number(v || 0).toLocaleString("th-TH", {
      minimumFractionDigits: this._config.decimals,
      maximumFractionDigits: this._config.decimals,
    });
  }

  // Compact axis tick: drop the decimals when the value is whole.
  _fmtTick(v) {
    if (Math.abs(v - Math.round(v)) < 1e-9) {
      return Number(Math.round(v)).toLocaleString("th-TH");
    }
    return this._fmt(v);
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
    const dt = new Date(y, m - 1, d);
    return dt.toLocaleDateString("th-TH", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
    });
  }
}

customElements.define("solar-energy-compare-card", SolarEnergyCompareCard);

/* ---------- Visual Editor ---------- */
class SolarEnergyCompareCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    this._config = { ...config };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    // re-render once hass is available so entity pickers get hass
    if (this.shadowRoot && this.shadowRoot.innerHTML === "") this._render();
    this.shadowRoot?.querySelectorAll("ha-entity-picker").forEach(p => { p.hass = hass; });
  }

  _update(key, value) {
    const next = { ...this._config, [key]: value };
    this._config = next;
    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: next },
      bubbles: true,
      composed: true,
    }));
  }

  _render() {
    if (!this.shadowRoot) return;
    const c = this._config || {};
    this.shadowRoot.innerHTML = `
      <style>
        .wrap { display:flex; flex-direction:column; gap:12px; padding:4px 2px; }
        .row2 { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
        ha-textfield, ha-entity-picker, ha-select { width:100%; display:block; }
        .note { font-size:12px; color:var(--secondary-text-color); }
      </style>
      <div class="wrap">
        <ha-entity-picker
          label="Solar entity (พลังงานสะสม)"
          .hass=${this._hass}
          .value=${c.solar_entity || ""}
          @value-changed=${e => this._update("solar_entity", e.detail.value)}
          allow-custom-entity
        ></ha-entity-picker>
        <ha-entity-picker
          label="Usage entity (พลังงานสะสม)"
          .hass=${this._hass}
          .value=${c.usage_entity || ""}
          @value-changed=${e => this._update("usage_entity", e.detail.value)}
          allow-custom-entity
        ></ha-entity-picker>
        <ha-textfield
          label="Title"
          .value=${c.title || ""}
          @input=${e => this._update("title", e.target.value)}
        ></ha-textfield>
        <div class="row2">
          <ha-textfield label="Solar label" .value=${c.solar_label || ""}
            @input=${e => this._update("solar_label", e.target.value)}></ha-textfield>
          <ha-textfield label="Usage label" .value=${c.usage_label || ""}
            @input=${e => this._update("usage_label", e.target.value)}></ha-textfield>
        </div>
        <div class="row2">
          <ha-textfield label="Chart tab label" .value=${c.chart_label || ""}
            @input=${e => this._update("chart_label", e.target.value)}></ha-textfield>
          <ha-textfield label="List tab label" .value=${c.list_label || ""}
            @input=${e => this._update("list_label", e.target.value)}></ha-textfield>
        </div>
        <div class="row2">
          <ha-textfield label="Days" type="number" .value=${c.days ?? 15}
            @input=${e => this._update("days", Number(e.target.value) || 15)}></ha-textfield>
          <ha-textfield label="Decimals" type="number" .value=${c.decimals ?? 1}
            @input=${e => this._update("decimals", Number(e.target.value) || 0)}></ha-textfield>
        </div>
        <ha-select label="Aggregation" .value=${c.aggregation || "delta"}
          @value-changed=${e => this._update("aggregation", e.detail.value)}
          @closed=${e => e.stopPropagation()}>
          <mwc-list-item value="delta">delta — คำนวณรายวันจากค่าต่าง (sensor สะสม)</mwc-list-item>
          <mwc-list-item value="daily">daily — sensor เป็นค่ารายวันอยู่แล้ว</mwc-list-item>
        </ha-select>
        <div class="note">entity ควรเป็น sensor พลังงานสะสม (kWh) ที่ถูกบันทึกใน recorder หรือมี long-term statistics</div>
      </div>
    `;
    this.shadowRoot.querySelectorAll("ha-entity-picker").forEach(p => {
      if (this._hass) p.hass = this._hass;
    });
  }
}

customElements.define("solar-energy-compare-card-editor", SolarEnergyCompareCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "solar-energy-compare-card",
  name: "Solar Energy Compare Card",
  description: "Compare daily solar production vs household energy use.",
  preview: true,
});
