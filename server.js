require('dotenv').config();
const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const session = require('express-session');
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const PRODUCT_LINK = 'https://labs.google/fx/tools/flow/shared/tool/14eadca6-64db-419d-b6bb-d4272c568d31';
const TUTORIAL_LINK = 'https://drive.google.com/file/d/1P9kpEbtBABfigy0gGaZgCdDq_Jax84K-/view?usp=sharing';
const LINE_GROUP_LINK = 'https://line.me/ti/g2/3XDsT6bNx2X90Or8--xd-2WpSyvcuQ7bsVrWjA?utm_source=invitation&utm_medium=link_copy&utm_campaign=default';

// ---------- DATA ----------
const UPLOADS_DIR = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const DB_FILE = path.join(__dirname, 'orders.json');
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, '[]');
function readOrders() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
function saveOrders(o) { fs.writeFileSync(DB_FILE, JSON.stringify(o, null, 2)); }

// ---------- UPLOAD ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'public/uploads')),
  filename: (req, file, cb) => cb(null, `slip_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => file.mimetype.startsWith('image/') ? cb(null, true) : cb(new Error('Images only'))
});

// ---------- EMAIL ----------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
});

// ---------- SESSION ----------
app.use(session({
  secret: process.env.SESSION_SECRET || 'adpro-secret-key-2025',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // จำ 7 วัน
}));

// ---------- PASSPORT ----------
app.use(passport.initialize());
app.use(passport.session());

passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID || 'PLACEHOLDER',
  clientSecret: process.env.GOOGLE_CLIENT_SECRET || 'PLACEHOLDER',
  callbackURL: `${BASE_URL}/auth/google/callback`
}, (accessToken, refreshToken, profile, done) => {
  done(null, {
    id: profile.id,
    name: profile.displayName,
    email: profile.emails?.[0]?.value || '',
    photo: profile.photos?.[0]?.value || ''
  });
}));

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((user, done) => done(null, user));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- QR IMAGE (JPG saved as .png fix) ----------
app.get('/qr.png', (req, res) => {
  const filePath = path.join(__dirname, 'public', 'qr.png');
  res.sendFile(filePath);
});

app.use(express.static(path.join(__dirname, 'public')));

// ---------- AUTH ROUTES ----------
app.get('/auth/google', passport.authenticate('google', { scope: ['profile', 'email'] }));

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/?error=1' }),
  (req, res) => res.redirect('/#payment')
);

app.get('/auth/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

app.get('/api/me', (req, res) => {
  if (req.user) res.json({ loggedIn: true, user: req.user });
  else res.json({ loggedIn: false });
});

// ---------- GOOGLE SHEETS ----------
async function getSheetsClient() {
  if (!process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || !process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY) return null;
  const auth = new google.auth.GoogleAuth({
    credentials: {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    },
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return google.sheets({ version: 'v4', auth });
}

async function getSheetName(sheets) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: process.env.GOOGLE_SHEET_ID });
    return meta.data.sheets[0].properties.title;
  } catch(e) { return 'Sheet1'; }
}

async function ensureSheetHeaders(sheets, sheetName) {
  if (!process.env.GOOGLE_SHEET_ID) return;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${sheetName}!A1`,
    });
    if (!res.data.values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `${sheetName}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['Order ID','ชื่อ','อีเมล','เบอร์โทร','Google Account','สถานะ','วันที่สั่ง','วันที่ Approve','ราคา','สลิป']] }
      });
    }
  } catch(e) { console.error('Sheet headers error:', e.message); }
}

async function appendOrderToSheet(order) {
  if (!process.env.GOOGLE_SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    const sheetName = await getSheetName(sheets);
    await ensureSheetHeaders(sheets, sheetName);
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${sheetName}!A:J`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[
        order.id, order.name, order.email, order.phone,
        order.googleEmail || '-',
        '⏳ รอ Approve',
        new Date(order.createdAt).toLocaleString('th-TH'),
        '-', '฿349', order.slipFile
      ]]}
    });
  } catch(e) { console.error('Sheets append error:', e.message); }
}

async function updateSheetApproved(order) {
  if (!process.env.GOOGLE_SHEET_ID) return;
  try {
    const sheets = await getSheetsClient();
    if (!sheets) return;
    const sheetName = await getSheetName(sheets);
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: `${sheetName}!A:A`,
    });
    const rows = res.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === order.id);
    if (rowIdx > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `${sheetName}!F${rowIdx + 1}:H${rowIdx + 1}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [['✅ Approved', new Date(order.approvedAt).toLocaleString('th-TH'), '฿349']] }
      });
    }
  } catch(e) { console.error('Sheets update error:', e.message); }
}

// ---------- ORDER SUBMIT ----------
app.post('/api/order', upload.single('slip'), async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    if (!name || !email || !req.file)
      return res.status(400).json({ success: false, message: 'กรุณากรอกข้อมูลให้ครบถ้วน' });

    const order = {
      id: uuidv4(),
      name, email,
      phone: phone || '-',
      googleEmail: req.user?.email || null,
      googleName: req.user?.name || null,
      slipFile: req.file.filename,
      approveToken: crypto.randomBytes(32).toString('hex'),
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    const orders = readOrders();
    orders.push(order);
    saveOrders(orders);

    // ตอบ success ก่อนเลย ไม่รอ email/sheet
    res.json({ success: true });

    // ส่ง email + sheet ใน background
    appendOrderToSheet(order).catch(e => console.error('Sheet error:', e.message));

    const approveLink = `${BASE_URL}/approve/${order.approveToken}`;
    await transporter.sendMail({
      from: `"StoryPro System" <${process.env.GMAIL_USER}>`,
      to: process.env.ADMIN_EMAIL,
      subject: `🛒 ออเดอร์ใหม่ - ${name} | StoryPro`,
      html: `
        <div style="font-family:sans-serif;max-width:580px;margin:0 auto">
          <div style="background:#f97316;padding:20px;text-align:center;border-radius:8px 8px 0 0">
            <h2 style="color:white;margin:0">🎉 ออเดอร์ใหม่!</h2>
          </div>
          <div style="background:#fff;padding:28px;border:1px solid #fed7aa;border-radius:0 0 8px 8px">
            <table style="width:100%;border-collapse:collapse">
              <tr><td style="padding:8px;color:#888">ชื่อ:</td><td style="padding:8px;font-weight:bold">${name}</td></tr>
              <tr style="background:#fff7ed"><td style="padding:8px;color:#888">อีเมล:</td><td style="padding:8px;font-weight:bold">${email}</td></tr>
              <tr><td style="padding:8px;color:#888">Google:</td><td style="padding:8px">${order.googleEmail || '-'}</td></tr>
              <tr style="background:#fff7ed"><td style="padding:8px;color:#888">เบอร์:</td><td style="padding:8px">${phone || '-'}</td></tr>
            </table>
            <div style="text-align:center;margin:20px 0">
              <p style="color:#888;font-size:13px;margin-bottom:8px">📎 สลิปโอนเงิน (แนบมาด้านล่าง)</p>
              <img src="cid:slip_image" style="max-width:300px;border-radius:8px;border:2px solid #fed7aa"/>
            </div>
            <div style="text-align:center">
              <a href="${approveLink}" style="background:#f97316;color:white;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:17px;font-weight:bold;display:inline-block">✅ Approve ออเดอร์นี้</a>
            </div>
          </div>
        </div>`,
      attachments: [{
        filename: req.file.originalname || 'slip.jpg',
        path: req.file.path,
        cid: 'slip_image'
      }]
    }).catch(e => console.error('Email error:', e.message));

  } catch(err) {
    console.error(err);
    if (!res.headersSent)
      res.status(500).json({ success: false, message: 'เกิดข้อผิดพลาด กรุณาลองใหม่' });
  }
});

// ---------- APPROVE ----------
app.get('/approve/:token', async (req, res) => {
  const orders = readOrders();
  const order = orders.find(o => o.approveToken === req.params.token);
  if (!order) return res.send('<h2 style="font-family:sans-serif">ไม่พบออเดอร์นี้</h2>');
  if (order.status === 'approved')
    return res.send(`<h2 style="font-family:sans-serif;color:#f97316">✅ Approve แล้ว (${order.name})</h2>`);

  order.status = 'approved';
  order.approvedAt = new Date().toISOString();
  saveOrders(orders);
  await updateSheetApproved(order);

  await transporter.sendMail({
    from: `"StoryPro by Flowbanhere" <${process.env.GMAIL_USER}>`,
    to: order.email,
    subject: `✅ ยืนยันการชำระเงิน - รับลิงก์ StoryPro Ver 4 ได้เลย!`,
    html: `
      <div style="font-family:sans-serif;max-width:580px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:28px;text-align:center;border-radius:8px 8px 0 0">
          <h1 style="color:white;margin:0;font-size:22px">🎊 ยืนยันการชำระเงินแล้ว!</h1>
          <p style="color:rgba(255,255,255,.85);margin:8px 0 0;font-size:14px">StoryPro by Flowbanhere — Ver 4</p>
        </div>
        <div style="background:#fff;padding:28px;border:1px solid #fed7aa;border-radius:0 0 8px 8px">
          <p style="font-size:15px">สวัสดี <strong>${order.name}</strong> 👋 ขอบคุณที่ใช้บริการครับ!</p>

          <!-- 1. Program link -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:20px 0">
            <p style="font-weight:800;font-size:15px;margin:0 0 8px;color:#1e293b">🤖 1. ลิงก์โปรแกรม StoryPro Ver 4</p>
            <div style="background:#fff;border:1px dashed #f97316;border-radius:8px;padding:12px;word-break:break-all;font-size:13px;color:#f97316;margin-bottom:10px">${PRODUCT_LINK}</div>
            <p style="font-size:12px;color:#64748b;margin:0">⚠️ <strong>วิธีเปิด:</strong> ก็อปปี้ลิงก์ข้างบน → เปิด Google Chrome → วางในแถบ Address แล้วกด Enter<br/><strong>ใช้ได้บน Computer เท่านั้น</strong></p>
          </div>

          <!-- 2. Tutorial -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:20px 0">
            <p style="font-weight:800;font-size:15px;margin:0 0 12px;color:#1e293b">▶️ 2. คลิปสอนการใช้งาน</p>
            <a href="${TUTORIAL_LINK}" style="background:#ef4444;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:bold;display:inline-block">▶ ดูคลิปสอน</a>
          </div>

          <!-- 3. Line group -->
          <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:12px;padding:20px;margin:20px 0">
            <p style="font-weight:800;font-size:15px;margin:0 0 8px;color:#1e293b">💬 3. ไลน์กลุ่ม Community</p>
            <p style="font-size:13px;color:#64748b;margin:0 0 12px">StoryPro by Flowบ้านเฮีย — ช่วยเหลือกัน เฮียตอบไว</p>
            <a href="${LINE_GROUP_LINK}" style="background:#06c755;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:bold;display:inline-block">💬 เข้ากลุ่มไลน์</a>
          </div>

          <!-- Rules -->
          <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:12px;padding:20px;margin:20px 0">
            <p style="font-weight:800;font-size:14px;margin:0 0 12px;color:#ea580c">📋 กฎกติกาการใช้งาน</p>
            <ul style="font-size:13px;color:#6b7280;padding-left:18px;line-height:2">
              <li>ห้ามดัดแปลง ทำซ้ำ หรือนำไปแจกจ่าย ขายต่อ</li>
              <li>หากมีปัญหาการใช้งานทักส่วนตัวเท่านั้น</li>
              <li>ก่อดราม่าในกลุ่มรวม เตะออกทุกกรณี</li>
            </ul>
          </div>

          <div style="text-align:center;margin-top:24px">
            <a href="${BASE_URL}/download?t=${order.approveToken}" style="background:linear-gradient(135deg,#f97316,#ea580c);color:white;padding:14px 32px;border-radius:10px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">🚀 เข้าหน้าดาวน์โหลด</a>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center;margin-top:20px">ติดต่อ: boategrshop@gmail.com</p>
        </div>
      </div>`
  });

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><meta http-equiv="refresh" content="3;url=${BASE_URL}/download?t=${order.approveToken}"><style>
    body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a}
    .box{text-align:center;padding:48px;background:#1a1a1a;border-radius:20px;border:1px solid rgba(249,115,22,.3);max-width:400px;width:90%}
    h2{color:#f97316}p{color:#888}strong{color:#f1f1f1}
  </style></head><body><div class="box">
    <div style="font-size:60px">🎉</div>
    <h2>Approve สำเร็จ!</h2>
    <p>ส่งลิงก์ไปที่<br><strong>${order.email}</strong></p>
    <p style="margin-top:12px;font-size:13px">กำลังพาไปหน้าดาวน์โหลด...</p>
  </div></body></html>`);

});

// ---------- DOWNLOAD (ต้องมี token ที่ approved แล้วเท่านั้น) ----------
app.get('/download', (req, res) => {
  const token = req.query.t;
  if (!token) return res.redirect('/?error=noaccess');
  const orders = readOrders();
  const order = orders.find(o => o.approveToken === token && o.status === 'approved');
  if (!order) return res.redirect('/?error=noaccess');
  res.sendFile(path.join(__dirname, 'public', 'download.html'));
});

// ---------- ADMIN ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/orders', (req, res) => res.json(readOrders().reverse()));

app.listen(PORT, () => {
  console.log(`\n🚀 Adpro: ${BASE_URL}`);
  console.log(`📊 Admin: ${BASE_URL}/admin\n`);
});
