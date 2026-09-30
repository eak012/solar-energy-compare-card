/* solar-energy-compare-card.js v7
 * Home Assistant Lovelace Custom Card
 * Compares daily solar production and household energy use.
 * v2: adds กราฟ / รายการ tabs to match design mock.
 * v6: legend shows today's values; adds solar/usage ratio bar.
 * v7: replaces ratio bar with daily diff + self-sufficiency stat boxes.
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
    this._configTimer = null;
    this._refreshTimer = null;
    this._lastFetch = 0;
  }

  setConfig(config) {
    // Capture previous entities BEFORE overwriting so entity changes
    // in the visual editor are detected and trigger a reload.
    const prevEntities = `${this._config?.solar_entity}|${this._config?.usage_entity}|${this._config?.days}|${this._config?.aggregation}`;
    const wasMissing = this._configMissing;
    this._config = {
      days: 15,
      title: "เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน",
      solar_label: "ผลิตไฟ",
      usage_label: "ใช้ไฟ",
      chart_label: "กราฟ",
      list_label: "รายการ",
      diff_label: "ส่วนต่างวันนี้",
      self_label: "พึ่งพาตัวเอง",
      unit: "kWh",
      decimals: 1,
      history_hours: 24 * 17,
      aggregation: "delta",
      ...config,
    };
    // Don't throw for missing entities — show a friendly placeholder instead.
    // This keeps getStubConfig("") working and the visual editor usable.
    this._configMissing = !config?.solar_entity || !config?.usage_entity;
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
    } else {
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

  getCardSize() { return 4; }

  static getConfigElement() {
    return document.createElement("solar-energy-compare-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:solar-energy-compare-card",
      solar_entity: "",
      usage_entity: "",
      days: 15,
      title: "เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน",
      solar_label: "ผลิตไฟ",
      usage_label: "ใช้ไฟ",
      chart_label: "กราฟ",
      list_label: "รายการ",
      diff_label: "ส่วนต่างวันนี้",
      self_label: "พึ่งพาตัวเอง",
      decimals: 1,
      aggregation: "delta",
    };
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
      const days = Math.max(3, Math.min(31, Number(this._config.days) || 15));
      const now = new Date();
      // +3 days buffer: delta needs the previous day's last reading
      const start = new Date(now.getTime() - (days + 3) * 24 * 3600 * 1000);

      const [solarHistory, usageHistory] = await Promise.all([
        this._fetchHistory(this._config.solar_entity, start),
        this._fetchHistory(this._config.usage_entity, start),
      ]);

      // Fallback: long-term statistics. Recorder keeps only ~10 days of raw
      // history by default (and some entities are excluded from recorder),
      // but energy sensors almost always have long-term statistics.
      let solarStat = null;
      let usageStat = null;
      if (!solarHistory.length) {
        solarStat = await this._fetchDailyStatistics(this._config.solar_entity, days).catch(() => null);
      }
      if (!usageHistory.length) {
        usageStat = await this._fetchDailyStatistics(this._config.usage_entity, days).catch(() => null);
      }

      console.debug("[solar-energy-compare-card] history points:",
        this._config.solar_entity, solarHistory.length,
        this._config.usage_entity, usageHistory.length,
        "| stat days:", solarStat?.size ?? "-", usageStat?.size ?? "-");

      const all = this._buildDailyData(solarHistory, usageHistory, solarStat, usageStat);
      this._data = all.slice(-days);

      if (!this._data.length) {
        console.warn("[solar-energy-compare-card] no daily data. Check that the entity_ids exist and are recorded (recorder) or have long-term statistics:",
          this._config.solar_entity, this._config.usage_entity);
      }
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

  _fetchHistory(entityId, start) {
    return this._hass.callWS({
      type: "history/history_during_period",
      start_time: start.toISOString(),
      end_time: new Date().toISOString(),
      entity_ids: [entityId],
      minimal_response: false,
      no_attributes: true,
      significant_changes_only: false,
    }).then(result => {
      if (!result) return [];
      if (Array.isArray(result)) {
        const found = result.find(r => r && r.entity_id === entityId);
        return (found && (found.states || found.data)) || [];
      }
      return result[entityId] || [];
    }).catch(err => {
      console.warn("[solar-energy-compare-card] history failed for", entityId, err?.message || err);
      return [];
    });
  }

  // Long-term statistics fallback -> Map("YYYY-MM-DD" -> kWh used that day).
  // Prefers per-day `change` (already a daily delta); otherwise diffs the
  // cumulative `sum`/`state` of consecutive days.
  async _fetchDailyStatistics(entityId, days) {
    const end = new Date();
    const start = new Date(end.getTime() - (days + 2) * 24 * 3600 * 1000);
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    const toMs = (t) => {
      if (t == null) return NaN;
      if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
      return Date.parse(t);
    };
    const callStats = (types) => this._hass.callWS({
      type: "recorder/statistics_during_period",
      start_time: start.toISOString(),
      end_time: end.toISOString(),
      period: "day",
      statistic_ids: [entityId],
      ...(types ? { statistic_types: types } : {}),
    });

    let result;
    try {
      result = await callStats(["change", "sum", "state"]);
    } catch (e) {
      result = await callStats(null); // older HA without "change" type
    }

    const rows = (result?.[entityId] || [])
      .map(r => ({
        ms: toMs(r.start),
        change: num(r.change),
        sum: num(r.sum),
        state: num(r.state),
      }))
      .filter(r => Number.isFinite(r.ms))
      .sort((a, b) => a.ms - b.ms);

    const map = new Map();
    let prevSum = null;
    let prevState = null;
    for (const r of rows) {
      const key = this._localDateKey(new Date(r.ms));
      let daily = null;
      if (r.change != null) {
        daily = Math.max(0, r.change);
      } else if (r.sum != null && prevSum != null) {
        daily = r.sum - prevSum;
        if (daily < 0) daily = Math.max(0, r.sum); // counter reset
      } else if (r.state != null && prevState != null) {
        daily = r.state - prevState;
        if (daily < 0) daily = Math.max(0, r.state);
      }
      if (daily != null && Number.isFinite(daily)) map.set(key, Math.max(0, daily));
      if (r.sum != null) prevSum = r.sum;
      if (r.state != null) prevState = r.state;
    }
    return map;
  }

  _buildDailyData(solarPts, usagePts, solarStat, usageStat) {
    if (this._config.aggregation === "daily") {
      return this._buildDailyLastValue(solarPts, usagePts);
    }
    return this._buildDeltaDaily(solarPts, usagePts, solarStat, usageStat);
  }

  // delta mode: daily = last reading of the day − last reading of the
  // previous day. Works with sparse history (even 1 reading/day).
  // Entities with no recorder history fall back to long-term statistics.
  _buildDeltaDaily(solarPts, usagePts, solarStat, usageStat) {
    const perEntity = (pts) => {
      const norm = this._normaliseHistory(pts);
      const lastByDate = new Map();
      for (const p of norm) lastByDate.set(p.date, p.value);
      const dates = [...lastByDate.keys()].sort();
      const out = new Map();
      let prev = null;
      for (const d of dates) {
        const cur = lastByDate.get(d);
        if (prev != null && cur != null) {
          let delta = cur - prev;
          if (delta < 0) {
            // counter reset across the gap: use within-day positive movement
            delta = this._withinDayGain(norm, d);
            if (!(delta > 0)) delta = Math.max(0, cur);
          }
          out.set(d, Math.max(0, delta));
        }
        if (cur != null) prev = cur;
      }
      return out;
    };

    const sD = perEntity(solarPts);
    const uD = perEntity(usagePts);

    const useStatS = sD.size === 0 && solarStat && solarStat.size > 0;
    const useStatU = uD.size === 0 && usageStat && usageStat.size > 0;

    const dates = new Set([
      ...sD.keys(),
      ...uD.keys(),
      ...(useStatS ? solarStat.keys() : []),
      ...(useStatU ? usageStat.keys() : []),
    ]);
    return [...dates].sort().map(date => ({
      date,
      solar: this._safe(useStatS ? (solarStat.get(date) ?? 0) : (sD.get(date) ?? 0)),
      usage: this._safe(useStatU ? (usageStat.get(date) ?? 0) : (uD.get(date) ?? 0)),
    }));
  }

  _buildDailyLastValue(solarPts, usagePts) {
    const lastByDate = (pts) => {
      const m = new Map();
      for (const p of this._normaliseHistory(pts)) m.set(p.date, p.value);
      return m;
    };
    const sM = lastByDate(solarPts);
    const uM = lastByDate(usagePts);
    const dates = new Set([...sM.keys(), ...uM.keys()]);
    return [...dates].sort().map(date => ({
      date,
      solar: this._safe(sM.get(date) ?? 0),
      usage: this._safe(uM.get(date) ?? 0),
    }));
  }

  _withinDayGain(norm, date) {
    let gain = 0;
    let prev = null;
    for (const p of norm) {
      if (p.date !== date) continue;
      if (prev != null && p.value > prev) gain += p.value - prev;
      prev = p.value;
    }
    return gain;
  }

  _normaliseHistory(history) {
    return (history || [])
      .map(item => {
        const value = Number.parseFloat(item.state ?? item.s);
        let ms = Date.parse(item.last_changed || item.last_updated || "");
        if (!Number.isFinite(ms)) {
          const lc = item.lc ?? item.lu;
          const n = Number(lc);
          if (Number.isFinite(n)) ms = n < 1e12 ? n * 1000 : n;
        }
        const dt = new Date(ms);
        return {
          value,
          dt,
          date: Number.isFinite(ms) ? this._localDateKey(dt) : null,
        };
      })
      .filter(x => Number.isFinite(x.value) && x.date)
      .sort((a, b) => a.dt - b.dt);
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

    if (this._configMissing) {
      this.shadowRoot.innerHTML = `${style}<ha-card><div class="empty" style="padding:28px 16px;">กรุณาเลือก solar_entity และ usage_entity<br><small>เปิด Visual editor เพื่อเลือก entity</small></div></ha-card>`;
      return;
    }

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

          ${this._summaryHtml(data)}

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

  // Summary header: today's values per entity + stat boxes for
  // today's net difference and self-sufficiency.
  _summaryHtml(data) {
    const today = data && data.length ? data[data.length - 1] : null;
    const todaySolar = today ? today.solar : 0;
    const todayUsage = today ? today.usage : 0;

    const diff = todaySolar - todayUsage;
    const diffText = (diff >= 0 ? "+" : "−") + this._fmt(Math.abs(diff)) + " kWh";
    const selfPct = todayUsage > 0
      ? (Math.min(todaySolar, todayUsage) / todayUsage) * 100
      : 0;

    return `
      <div class="legend">
        <span><i class="dot solar"></i>${this._esc(this._config.solar_label)} <b class="legend-val">${today ? this._fmt(todaySolar) : "–"} kWh</b></span>
        <span><i class="dot usage"></i>${this._esc(this._config.usage_label)} <b class="legend-val">${today ? this._fmt(todayUsage) : "–"} kWh</b></span>
      </div>
      <div class="stats">
        <div class="stat">
          <div class="stat-label">${this._esc(this._config.diff_label)}</div>
          <div class="stat-value ${diff >= 0 ? "pos" : "neg"}">${diffText}</div>
        </div>
        <div class="stat">
          <div class="stat-label">${this._esc(this._config.self_label)}</div>
          <div class="stat-value self">${selfPct.toFixed(1)}%</div>
        </div>
      </div>
    `;
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
      .legend-val { color:var(--primary-text-color, #212121);
        font-variant-numeric:tabular-nums; }
      .dot { display:inline-block; width:10px; height:10px; border-radius:50%;
        margin-right:7px; vertical-align:-1px; }
      .dot.solar { background:var(--solar-color); }
      .dot.usage { background:var(--usage-color); }

      /* Stat boxes: today's net diff + self-sufficiency */
      .stats { display:flex; gap:8px; margin:0 0 8px; }
      .stat { flex:1; background:rgba(127,127,127,.10);
        border:1px solid var(--divider-color, rgba(127,127,127,.25));
        border-radius:11px; padding:7px 10px; text-align:center; }
      .stat-label { font-size:11px; line-height:1.4;
        color:var(--secondary-text-color, #727272); }
      .stat-value { font-size:16px; font-weight:700; line-height:1.4;
        font-variant-numeric:tabular-nums; }
      .stat-value.pos { color:var(--success-color, #43a047); }
      .stat-value.neg { color:var(--error-color, #db4437); }
      .stat-value.self { color:var(--primary-color, #1f7ae0); }

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
    // drop empty optional strings to keep yaml clean, but keep required entities even if empty
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
        .hint { font-size:12px; color:var(--secondary-text-color, #888); margin-top:-8px; }
        .section { font-weight:600; font-size:13px; margin-top:4px; color:var(--primary-text-color); }
      </style>
      <div class="wrap">
        <div class="section">Entities</div>
        <ha-entity-picker id="solar_entity" label="Solar entity (ผลิตไฟ)"></ha-entity-picker>
        <ha-entity-picker id="usage_entity" label="Usage entity (ใช้ไฟบ้าน)"></ha-entity-picker>
        <div class="hint">รองรับ sensor ที่เป็น cumulative kWh (มิเตอร์สะสม) เป็นค่าเริ่มต้น</div>

        <div class="section">Display</div>
        <ha-textfield id="title" label="Title"></ha-textfield>
        <div class="row2">
          <ha-textfield id="solar_label" label="Solar label"></ha-textfield>
          <ha-textfield id="usage_label" label="Usage label"></ha-textfield>
        </div>
        <div class="row2">
          <ha-textfield id="chart_label" label="Chart tab (กราฟ)"></ha-textfield>
          <ha-textfield id="list_label" label="List tab (รายการ)"></ha-textfield>
        </div>
        <div class="row2">
          <ha-textfield id="diff_label" label="Diff label (ส่วนต่าง)"></ha-textfield>
          <ha-textfield id="self_label" label="Self-sufficiency label"></ha-textfield>
        </div>
        <div class="row2">
          <ha-textfield id="days" label="Days (3-31)" type="number" min="3" max="31" inputmode="numeric"></ha-textfield>
          <ha-textfield id="decimals" label="Decimals (0-3)" type="number" min="0" max="3" inputmode="numeric"></ha-textfield>
        </div>

        <div class="section">Data</div>
        <ha-select id="aggregation" label="Aggregation">
          <mwc-list-item value="delta">delta — คำนวณรายวันจากมิเตอร์สะสม</mwc-list-item>
          <mwc-list-item value="daily">daily — entity เป็นค่ารายวันอยู่แล้ว</mwc-list-item>
        </ha-select>
        <div class="hint">ถ้า sensor รีเซ็ตทุกวันให้เลือก daily, ถ้าเป็นมิเตอร์สะสมให้ใช้ delta</div>
      </div>
    `;

    const $ = (id) => this.shadowRoot.querySelector("#" + id);

    // Set values as properties (not attributes) so HA web components pick them up
    const solarPicker = $("solar_entity");
    const usagePicker = $("usage_entity");
    if (solarPicker) {
      solarPicker.hass = this._hass;
      solarPicker.value = c.solar_entity || "";
      solarPicker.setAttribute("label", "Solar entity (ผลิตไฟ)");
      try { solarPicker.setAttribute("domain-filter", "sensor"); } catch (e) {}
      solarPicker.allowCustomEntity = true;
      solarPicker.addEventListener("value-changed", e => this._update("solar_entity", e.detail.value));
    }
    if (usagePicker) {
      usagePicker.hass = this._hass;
      usagePicker.value = c.usage_entity || "";
      try { usagePicker.setAttribute("domain-filter", "sensor"); } catch (e) {}
      usagePicker.allowCustomEntity = true;
      usagePicker.addEventListener("value-changed", e => this._update("usage_entity", e.detail.value));
    }

    const setField = (id, val) => {
      const el = $(id);
      if (el) el.value = val ?? "";
    };
    setField("title", c.title || "");
    setField("solar_label", c.solar_label || "");
    setField("usage_label", c.usage_label || "");
    setField("chart_label", c.chart_label || "");
    setField("list_label", c.list_label || "");
    setField("diff_label", c.diff_label || "");
    setField("self_label", c.self_label || "");
    setField("days", c.days ?? 15);
    setField("decimals", c.decimals ?? 1);

    const onField = (id, key, isNumber) => {
      const el = $(id);
      if (!el) return;
      const handler = (e) => {
        let v = e.target.value;
        if (isNumber) {
          if (v === "" || v === null) { this._update(key, ""); return; }
          const n = Number(v);
          this._update(key, Number.isFinite(n) ? n : v);
          return;
        }
        this._update(key, v);
      };
      el.addEventListener("input", handler);
      el.addEventListener("change", handler);
    };
    onField("title", "title", false);
    onField("solar_label", "solar_label", false);
    onField("usage_label", "usage_label", false);
    onField("chart_label", "chart_label", false);
    onField("list_label", "list_label", false);
    onField("diff_label", "diff_label", false);
    onField("self_label", "self_label", false);
    onField("days", "days", true);
    onField("decimals", "decimals", true);

    const agg = $("aggregation");
    if (agg) {
      agg.value = c.aggregation || "delta";
      agg.addEventListener("value-changed", e => this._update("aggregation", e.detail.value));
      agg.addEventListener("change", e => {
        if (e.target.value) this._update("aggregation", e.target.value);
      });
      // fallback for older ha-select
      agg.addEventListener("closed", () => {
        if (agg.value && agg.value !== (this._config.aggregation || "delta")) {
          this._update("aggregation", agg.value);
        }
      });
    }
  }
}

customElements.define("solar-energy-compare-card-editor", SolarEnergyCompareCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "solar-energy-compare-card",
  name: "Solar Energy Compare Card",
  description: "Solar vs home usage chart with กราฟ/รายการ tabs, hover/touch tooltip.",
  preview: true,
});
