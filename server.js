require('dotenv').config();
const express = require('express');
const multer = require('multer');
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

const SETTINGS_FILE = path.join(__dirname, 'settings.json');
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ autoApprove: false }));
function readSettings() { try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); } catch { return { autoApprove: false }; } }
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)); }

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
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx7q8DMEA_gZqVICFFpLdSw23PuIgLtcztcXsr1DlMILjDZcanRtspfi0TELoczs3ZK/exec';

async function sendEmail(data) {
  try {
    const https = require('https');
    const body = JSON.stringify(data);
    const url = new URL(APPS_SCRIPT_URL);
    return new Promise((resolve) => {
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
      }, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => { console.log('📧 Email sent:', raw); resolve(true); });
      });
      req.on('error', e => { console.error('❌ Email error:', e.message); resolve(false); });
      req.write(body);
      req.end();
    });
  } catch(e) { console.error('❌ Email error:', e.message); return false; }
}

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

    // ถ้า auto-approve เปิดอยู่ → approve ทันทีเลย
    const { autoApprove } = readSettings();
    if (autoApprove) {
      console.log(`🤖 Auto-approving order ${order.id}`);
      const orders2 = readOrders();
      const o = orders2.find(x => x.id === order.id);
      if (o) {
        o.status = 'approved';
        o.approvedAt = new Date().toISOString();
        saveOrders(orders2);
        updateSheetApproved(o).catch(e => console.error('Sheet update error:', e.message));
        // ส่งลิงก์ให้ลูกค้า
        sendEmail({
          type: 'approve',
          name: o.name,
          email: o.email,
          downloadLink: `${BASE_URL}/download?t=${o.approveToken}`
        }).catch(e => console.error('Email error:', e.message));
        // แจ้งแอดมินด้วย แต่ mark ว่า auto-approved แล้ว
        sendEmail({
          type: 'new_order',
          name: o.name,
          email: o.email,
          phone: o.phone,
          googleEmail: o.googleEmail,
          orderId: o.id,
          slipUrl: `${BASE_URL}/uploads/${o.slipFile}`,
          approveLink: null,
          adminLink: `${BASE_URL}/admin`,
          autoApproved: true
        }).catch(e => console.error('Email error:', e.message));
      }
    } else {
      sendEmail({
        type: 'new_order',
        name: order.name,
        email: order.email,
        phone: order.phone,
        googleEmail: order.googleEmail,
        orderId: order.id,
        slipUrl: `${BASE_URL}/uploads/${order.slipFile}`,
        approveLink,
        adminLink: `${BASE_URL}/admin`,
        autoApproved: false
      }).catch(e => console.error('Email error:', e.message));
    }

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

  sendEmail({
    type: 'approve',
    name: order.name,
    email: order.email,
    downloadLink: `${BASE_URL}/download?t=${order.approveToken}`
  }).catch(e => console.error('Email error:', e.message));

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

// ---------- MY ORDER (เช็คสถานะของคนที่ login อยู่) ----------
app.get('/api/my-order', (req, res) => {
  if (!req.user) return res.json({ status: 'not_logged_in' });
  const email = req.user.email?.toLowerCase();
  if (!email) return res.json({ status: 'no_email' });
  const orders = readOrders();
  const order = orders
    .filter(o => (o.googleEmail || '').toLowerCase() === email || (o.email || '').toLowerCase() === email)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
  if (!order) return res.json({ status: 'no_order' });
  if (order.status === 'approved')
    return res.json({ status: 'approved', downloadLink: `/download?t=${order.approveToken}`, name: order.name });
  return res.json({ status: 'pending', name: order.name });
});

// ---------- SETTINGS ----------
app.get('/api/settings', (req, res) => res.json(readSettings()));
app.post('/api/settings', express.json(), (req, res) => {
  const s = readSettings();
  if (typeof req.body.autoApprove === 'boolean') s.autoApprove = req.body.autoApprove;
  saveSettings(s);
  console.log(`⚙️ Auto-approve: ${s.autoApprove ? 'ON' : 'OFF'}`);
  res.json(s);
});

// ---------- ADMIN ----------
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/api/orders', (req, res) => res.json(readOrders().reverse()));

app.delete('/api/orders/:id', (req, res) => {
  const orders = readOrders();
  const idx = orders.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ success: false });
  orders.splice(idx, 1);
  saveOrders(orders);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Adpro: ${BASE_URL}`);
  console.log(`📊 Admin: ${BASE_URL}/admin\n`);
});
