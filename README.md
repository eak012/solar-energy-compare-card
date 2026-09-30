# Solar Energy Compare Card

การ์ดสำหรับ Home Assistant Lovelace ใช้เปรียบเทียบ **พลังงานที่ผลิตได้จากโซลาร์เซลล์** กับ **พลังงานที่ใช้ในบ้าน** รายวัน ย้อนหลังได้สูงสุด 31 วัน

## ✨ Features

- 📊 แท่งกราฟคู่ต่อวัน — เหลือง = ผลิตไฟ, น้ำเงิน = ใช้ไฟ
- 🗂️ แท็บ **กราฟ / รายการ** สลับมุมมองได้โดยไม่โหลดข้อมูลใหม่
- 💬 Hover / แตะที่แท่งกราฟ แสดง popup รายละเอียดรายวัน
- 🎨 ใช้สีพื้นหลังและฟอนต์ของธีม Home Assistant โดยอัตโนมัติ (รองรับทั้งธีมสว่าง/มืด)
- 🖱️ **Visual editor** — ตั้งค่าผ่าน UI ได้เลย ไม่ต้องเขียน YAML
- 🔋 รองรับ sensor มิเตอร์สะสม (kWh) โหมด `delta` และ sensor รายวัน โหมด `daily`
- 📦 ดึงข้อมูลจาก Recorder history และ fallback ไป **long-term statistics** อัตโนมัติเมื่อไม่มี history
- ⚡ รีเฟรชเบื้องหลังโดยไม่กระพริบ (throttle ทุก 5 นาที, ไม่ล้างกราฟขณะโหลด)
- 📦 ไม่ต้องพึ่ง ApexCharts หรือ library ภายนอก

## 📋 Requirements

- Home Assistant (รองรับ Lovelace custom card ทั่วไป)
- มี sensor 2 ตัว:
  - `solar_entity` — พลังงานสะสมที่ผลิตได้ (kWh, ค่าเพิ่มขึ้นเรื่อยๆ)
  - `usage_entity` — พลังงานสะสมที่ใช้ในบ้าน (kWh, ค่าเพิ่มขึ้นเรื่อยๆ)
- sensor ควรถูกบันทึกใน **Recorder** หรือมี **long-term statistics** (sensor ประเภท energy ส่วนใหญ่มีให้อัตโนมัติ)

## 🚀 Installation

### วิธีที่ 1: HACS (แนะนำ)

1. เปิด HACS → **Frontend** → ⋮ → **Custom repositories**
2. ใส่ URL: `https://github.com/eak012/solar-energy-compare-card.git` เลือกประเภท **Dashboard**
3. กด **Download** แล้ว refresh หน้า Lovelace

### วิธีที่ 2: ติดตั้งเอง (Manual)

1. คัดลอกไฟล์ `solar-energy-compare-card.js` ไปที่:

   ```text
   /config/www/solar-energy-compare-card.js
   ```

2. เพิ่ม resource ใน Lovelace (**Settings → Dashboards → Resources**):

   ```yaml
   url: /local/solar-energy-compare-card.js
   type: module
   ```

   > 💡 ทุกครั้งที่อัปเดตไฟล์ ให้เติม query string เพื่อล้าง cache เช่น `/local/solar-energy-compare-card.js?v=6` แล้ว hard refresh เบราว์เซอร์ (Ctrl/Cmd + Shift + R)

## 🛠️ Usage

### ผ่าน Visual Editor

1. เพิ่มการ์ด → ค้นหา **Solar Energy Compare Card**
2. เลือก `Solar entity` และ `Usage entity` จาก dropdown
3. ตั้งค่าอื่นๆ ได้เลย (title, label, จำนวนวัน, ทศนิยม, aggregation)

### ผ่าน YAML

```yaml
type: custom:solar-energy-compare-card
solar_entity: sensor.solar_meter_energy_total
usage_entity: sensor.main_energy
days: 15
title: เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน
solar_label: ผลิตไฟ
usage_label: ใช้ไฟ
chart_label: กราฟ
list_label: รายการ
decimals: 1
aggregation: delta
solar_color: '#ff5c23'
usage_color: '#c8f3ff'
```

## ⚙️ Configuration options

| Option         | Type    | Default                              | คำอธิบาย |
|----------------|---------|--------------------------------------|-----------|
| `solar_entity` | string  | — (บังคับ)                           | entity พลังงานสะสมที่ผลิตได้ (kWh) |
| `usage_entity` | string  | — (บังคับ)                           | entity พลังงานสะสมที่ใช้ในบ้าน (kWh) |
| `days`         | number  | `15`                                 | จำนวนวันย้อนหลัง (3–31) |
| `title`        | string  | `เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน` | หัวข้อการ์ด |
| `solar_label`  | string  | `ผลิตไฟ`                             | ชื่อเรียกฝั่งผลิตไฟ |
| `usage_label`  | string  | `ใช้ไฟ`                              | ชื่อเรียกฝั่งใช้ไฟ |
| `chart_label`  | string  | `กราฟ`                               | ชื่อแท็บกราฟ |
| `list_label`   | string  | `รายการ`                            | ชื่อแท็บรายการ |
| `decimals`     | number  | `1`                                  | จำนวนทศนิยม (0–3) |
| `aggregation`  | string  | `delta`                              | `delta` = คำนวณรายวันจากมิเตอร์สะสม, `daily` = entity เป็นค่ารายวันอยู่แล้ว |
|`solar_color`|HEX|— (บังคับ)|ใส่สีสำหรับ solar ผลิตไฟ|
|`usage_color`|HEX|— (บังคับ)|ใส่สีสำหรับการใช้ไฟบ้าน|

### `aggregation: delta` vs `daily`

- **delta** (ค่าเริ่มต้น) — สำหรับมิเตอร์สะสมที่ค่าเพิ่มขึ้นเรื่อยๆ การ์ดจะคำนวณ `ค่าสุดท้ายของวันนี้ − ค่าสุดท้ายของเมื่อวาน` รองรับ sensor ที่อัปเดตห่างๆ (แม้วันละครั้ง) และจัดการกรณีมิเตอร์รีเซ็ตให้เอง
- **daily** — สำหรับ sensor ที่รีเซ็ตเป็น 0 ทุกวันอยู่แล้ว การ์ดจะใช้ค่าสูงสุดของแต่ละวันโดยตรง

## 🔍 Troubleshooting

| อาการ | วิธีแก้ |
|------|--------|
| การ์ดขึ้น "ยังไม่มีข้อมูลย้อนหลัง" | เปิด browser console (F12) ดูบรรทัด `[solar-energy-compare-card] history points:` — ถ้าเป็น 0 ทั้งคู่ ให้เช็คว่า entity_id ถูกต้อง และ sensor ถูกบันทึกใน recorder (ดูที่ **Settings → System → Recorder**) หรือมี long-term statistics (**Developer Tools → Statistics**) |
| แก้ไฟล์แล้วไม่เปลี่ยน | เติม `?v=N` ท้าย resource URL แล้ว hard refresh |
| ขึ้น "Visual editor not supported" | ตรวจสอบว่าไฟล์ JS เป็นเวอร์ชันล่าสุด (ต้องมี `getConfigElement` / `getStubConfig`) แล้วล้าง cache |
| ตัวเลขไม่ตรงกับมิเตอร์ | เช็ค `aggregation` — มิเตอร์สะสมใช้ `delta`, sensor รายวันใช้ `daily` |

## 📁 Repository structure

```text
.
├── solar-energy-compare-card.js  # การ์ด (ไฟล์เดียวจบ)
├── hacs.json                     # config สำหรับ HACS
└── README.md
```

## 📄 License

MIT — ใช้งาน ดัดแปลง แจกจ่ายได้อย่างอิสระ
