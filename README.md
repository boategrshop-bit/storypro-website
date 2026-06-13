# Adpro By flowbanhere — Sales Website

## วิธีเริ่มใช้งาน

### 1. สร้าง Gmail App Password
1. ไปที่ https://myaccount.google.com/security
2. เปิด 2-Step Verification ก่อน (ถ้ายังไม่เปิด)
3. ไปที่ **App passwords** → สร้าง App Password ใหม่
4. คัดลอก password 16 ตัวอักษร

### 2. ใส่ App Password ใน .env
เปิดไฟล์ `.env` แล้วแทนที่ `ใส่-App-Password-ที่นี่` ด้วย App Password ที่ได้

### 3. เริ่ม server
```bash
npm start
```

เว็บจะรันที่ http://localhost:3000
Admin panel: http://localhost:3000/admin

---

## Deploy บน VPS / Cloud (แนะนำ)

ถ้าต้องการให้ลูกค้าเข้าจากอินเทอร์เน็ต:
1. เปลี่ยน `BASE_URL` ใน `.env` เป็น URL จริง เช่น `https://adpro.yourdomain.com`
2. ใช้ PM2: `npm install -g pm2 && pm2 start server.js`
