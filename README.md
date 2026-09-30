# Solar Energy Compare Card v2

Home Assistant Lovelace custom card สำหรับเปรียบเทียบการผลิตไฟโซลาร์ vs การใช้ไฟบ้าน ย้อนหลัง 15 วัน พร้อม tabs กราฟ/รายการ ตามดีไซน์

## มีอะไรใหม่ใน v2
- เพิ่ม tabs ด้านบน: **กราฟ** / **รายการ** ตรงตามภาพ mock
- มุมมองรายการ: แถว compact ใหม่สุดก่อน, มี mini bar เหลือง/ฟ้า + ตัวเลข kWh, กดเลือกวันได้
- คงฟีเจอร์เดิม: tooltip hover/touch, highlight วันที่เลือก, คำนวณ daily delta จาก Recorder

## ติดตั้ง
Copy `solar-energy-compare-card.js` ไปที่:
```
/config/www/solar-energy-compare-card.js
```
เพิ่ม resource:
```yaml
url: /local/solar-energy-compare-card.js
type: module
```

## ตัวอย่าง Lovelace
```yaml
type: custom:solar-energy-compare-card
solar_entity: sensor.solar
usage_entity: sensor.use_energy
days: 15
title: เปรียบเทียบการผลิตไฟ & การใช้ไฟบ้าน
# เปลี่ยนชื่อ tab ได้
# chart_label: กราฟ
# list_label: รายการ
```

ถ้า entity เป็นค่ารายวันอยู่แล้ว:
```yaml
aggregation: daily
```
