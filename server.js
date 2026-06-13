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
const PRODUCT_LINK = 'https://labs.google/fx/tools/flow/shared/tool/99c95438-6779-4092-8d15-056f19caec96';

// ---------- DATA ----------
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

async function ensureSheetHeaders(sheets) {
  if (!process.env.GOOGLE_SHEET_ID) return;
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A1',
    });
    if (!res.data.values) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: 'Sheet1!A1',
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
    await ensureSheetHeaders(sheets);
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:J',
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
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEET_ID,
      range: 'Sheet1!A:A',
    });
    const rows = res.data.values || [];
    const rowIdx = rows.findIndex(r => r[0] === order.id);
    if (rowIdx > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: process.env.GOOGLE_SHEET_ID,
        range: `Sheet1!F${rowIdx + 1}:H${rowIdx + 1}`,
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
    await appendOrderToSheet(order);

    const approveLink = `${BASE_URL}/approve/${order.approveToken}`;
    await transporter.sendMail({
      from: `"Adpro System" <${process.env.GMAIL_USER}>`,
      to: process.env.ADMIN_EMAIL,
      subject: `🛒 ออเดอร์ใหม่ - ${name} | Adpro`,
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
              <img src="${BASE_URL}/uploads/${req.file.filename}" style="max-width:280px;border-radius:8px;border:2px solid #fed7aa"/>
            </div>
            <div style="text-align:center">
              <a href="${approveLink}" style="background:#f97316;color:white;padding:14px 36px;border-radius:8px;text-decoration:none;font-size:17px;font-weight:bold;display:inline-block">✅ Approve ออเดอร์นี้</a>
            </div>
          </div>
        </div>`
    });

    res.json({ success: true });
  } catch(err) {
    console.error(err);
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
    from: `"Adpro By flowbanhere" <${process.env.GMAIL_USER}>`,
    to: order.email,
    subject: `✅ ยืนยันการชำระเงิน - เริ่มใช้งาน Adpro ได้เลย!`,
    html: `
      <div style="font-family:sans-serif;max-width:560px;margin:0 auto">
        <div style="background:linear-gradient(135deg,#f97316,#ea580c);padding:28px;text-align:center;border-radius:8px 8px 0 0">
          <h1 style="color:white;margin:0">🎊 ยืนยันการชำระเงินแล้ว!</h1>
        </div>
        <div style="background:#fff;padding:28px;border:1px solid #fed7aa;border-radius:0 0 8px 8px">
          <p>สวัสดี <strong>${order.name}</strong> 👋 ขอบคุณที่ใช้บริการ!</p>
          <div style="background:#fff7ed;border-radius:12px;padding:24px;margin:20px 0;text-align:center">
            <p style="color:#ea580c;font-weight:bold;font-size:17px;margin:0 0 14px">🚀 เริ่มใช้งาน Adpro ได้เลย!</p>
            <a href="${PRODUCT_LINK}" style="background:#f97316;color:white;padding:14px 32px;border-radius:8px;text-decoration:none;font-size:15px;font-weight:bold;display:inline-block">▶ เริ่มใช้งานเลย</a>
          </div>
          <p style="color:#9ca3af;font-size:12px;text-align:center">ติดต่อ: boategrshop@gmail.com</p>
        </div>
      </div>`
  });

  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
    body{font-family:sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#0a0a0a}
    .box{text-align:center;padding:48px;background:#1a1a1a;border-radius:20px;border:1px solid rgba(249,115,22,.3);max-width:400px;width:90%}
    h2{color:#f97316}p{color:#888}strong{color:#f1f1f1}
  </style></head><body><div class="box">
    <div style="font-size:60px">🎉</div>
    <h2>Approve สำเร็จ!</h2>
    <p>ส่งลิงก์ไปที่<br><strong>${order.email}</strong></p>
    <p>ลูกค้า: <strong>${order.name}</strong></p>
  </div></body></html>`);
});

// ---------- ADMIN ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/orders', (req, res) => res.json(readOrders().reverse()));

app.listen(PORT, () => {
  console.log(`\n🚀 Adpro: ${BASE_URL}`);
  console.log(`📊 Admin: ${BASE_URL}/admin\n`);
});
