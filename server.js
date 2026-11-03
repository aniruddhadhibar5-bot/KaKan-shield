const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('node:crypto');
const { randomUUID } = crypto;
const dns = require('node:dns/promises');
const http = require('node:http');
const https = require('node:https');
const { BlockList, isIP } = require('node:net');

const app = express();
const port = process.env.PORT || 3000;
const sessionSecret = process.env.SESSION_SECRET;
if (process.env.NODE_ENV === 'production' && !sessionSecret) {
  throw new Error('SESSION_SECRET must be configured when NODE_ENV=production');
}
if (process.env.NODE_ENV === 'production' && Buffer.byteLength(sessionSecret) < 32) {
  throw new Error('SESSION_SECRET must contain at least 32 bytes when NODE_ENV=production');
}
const encryptedDataMarker = Buffer.from('SBSENC1');
const rootDir = __dirname;
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(rootDir, 'data');
const uploadsDir = path.join(dataDir, 'uploads');
const usersFile = path.join(dataDir, 'users.json');
const clientsFile = path.join(dataDir, 'clients.json');
const filesFile = path.join(dataDir, 'files.json');
const startupFile = path.join(dataDir, 'startup.json');

const nonPublicAddresses = new BlockList();
const publicIPv6Addresses = new BlockList();
publicIPv6Addresses.addSubnet('2000::', 3, 'ipv6');
[
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
].forEach(([address, prefix]) => nonPublicAddresses.addSubnet(address, prefix, 'ipv4'));
[
  ['::', 128], ['::1', 128], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['100::', 64],
  ['2001::', 23], ['2002::', 16], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]
].forEach(([address, prefix]) => nonPublicAddresses.addSubnet(address, prefix, 'ipv6'));

function isPublicAddress(address, family) {
  const version = family === 4 || family === 'IPv4' ? 'ipv4' : 'ipv6';
  if (!isIP(address) || (version === 'ipv6' && !publicIPv6Addresses.check(address, version))) return false;
  return !nonPublicAddresses.check(address, version);
}

const defaultUsers = [
  { id: 'user-admin', name: 'Northstar Admin', email: 'admin@northstar.com', role: 'admin', title: 'Founder / Security Admin', country: 'Japan', city: 'Tokyo', timezone: 'Asia/Tokyo', passwordHash: bcrypt.hashSync('Shield@2026!', 10) },
  { id: 'user-ops', name: 'Operations Lead', email: 'ops@northstar.com', role: 'ops', title: 'Operations', country: 'India', city: 'Bengaluru', timezone: 'Asia/Kolkata', passwordHash: bcrypt.hashSync('Ops@2026!', 10) },
  { id: 'user-analyst', name: 'Research Analyst', email: 'research@northstar.com', role: 'analyst', title: 'Risk & Research', country: 'Singapore', city: 'Singapore', timezone: 'Asia/Singapore', passwordHash: bcrypt.hashSync('Research@2026!', 10) },
  { id: 'user-legal', name: 'Compliance Lead', email: 'compliance@northstar.com', role: 'viewer', title: 'Compliance Officer', country: 'USA', city: 'New York', timezone: 'America/New_York', passwordHash: bcrypt.hashSync('Compliance@2026!', 10) }
];

const seededClients = [
  { id: 'client-1', name: 'Nexa Labs', industry: 'AI SaaS', owner: 'Aita', region: 'Japan', status: 'Trusted', risk: 'Low' },
  { id: 'client-2', name: 'GreenCart', industry: 'Retail Tech', owner: 'Riya', region: 'India', status: 'Needs review', risk: 'Medium' },
  { id: 'client-3', name: 'Velora Mobility', industry: 'Mobility', owner: 'Sam', region: 'Singapore', status: 'Verified', risk: 'Low' }
];

const seededFiles = [
  { id: 'file-101', name: 'customer_leads_japan.csv', size: '1.8 MB', owner: 'Sales Ops', status: 'Encrypted', updated: '2h ago', risk: 'Low', storedName: 'customer_leads_japan.csv', preview: [['customer_id', 'region', 'score'], ['C-1024', 'Tokyo', '96']] },
  { id: 'file-102', name: 'invoice_exports_april.csv', size: '680 KB', owner: 'Finance', status: 'Protected', updated: '5h ago', risk: 'Low', storedName: 'invoice_exports_april.csv', preview: [['invoice_id', 'country', 'amount'], ['INV-104', 'Japan', '28400']] },
  { id: 'file-103', name: 'client_watchlist.csv', size: '420 KB', owner: 'Risk Desk', status: 'Review', updated: '1d ago', risk: 'Medium', storedName: 'client_watchlist.csv', preview: [['client_id', 'risk', 'owner'], ['CL-21', 'Medium', 'Riya']] }
];

const emptyStartupData = {
  finance: { cashBalance: 0, monthlyExpenses: 0, monthlyRevenue: 0 },
  tasks: []
};

function ensureDirectories() {
  [dataDir, uploadsDir].forEach((dir) => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

let dataEncryptionKey;

function isEncryptedData(value) {
  return value.length >= encryptedDataMarker.length
    && value.subarray(0, encryptedDataMarker.length).equals(encryptedDataMarker);
}

function encryptData(value) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', dataEncryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([encryptedDataMarker, iv, cipher.getAuthTag(), ciphertext]);
}

function decryptData(value) {
  if (!isEncryptedData(value)) return value;
  const markerLength = encryptedDataMarker.length;
  const iv = value.subarray(markerLength, markerLength + 12);
  const authTag = value.subarray(markerLength + 12, markerLength + 28);
  const ciphertext = value.subarray(markerLength + 28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', dataEncryptionKey, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function writeAtomically(filePath, value) {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`
  );
  try {
    fs.writeFileSync(temporaryPath, value, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
    throw error;
  }
}

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    saveJson(filePath, fallback);
    return JSON.parse(JSON.stringify(fallback));
  }

  try {
    const storedValue = fs.readFileSync(filePath);
    const encrypted = isEncryptedData(storedValue);
    const raw = decryptData(storedValue).toString('utf8');
    if (!raw.trim()) throw new SyntaxError('The file is empty.');
    const value = JSON.parse(raw);
    if (!encrypted) saveJson(filePath, value);
    return value;
  } catch (error) {
    throw new Error(`Unable to read valid JSON from ${filePath}; the existing file was left unchanged.`, { cause: error });
  }
}

function saveJson(filePath, value) {
  writeAtomically(filePath, encryptData(Buffer.from(JSON.stringify(value, null, 2), 'utf8')));
}

function resolveDataEncryptionKey() {
  const configuredKey = process.env.DATA_ENCRYPTION_KEY;
  if (configuredKey) {
    if (Buffer.byteLength(configuredKey, 'utf8') < 32) {
      throw new Error('DATA_ENCRYPTION_KEY must contain at least 32 bytes');
    }
    return crypto.createHash('sha256').update(configuredKey, 'utf8').digest();
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('DATA_ENCRYPTION_KEY must be configured when NODE_ENV=production');
  }

  const keyFile = path.join(dataDir, '.data-encryption-key');
  try {
    const storedKey = fs.readFileSync(keyFile, 'utf8').trim();
    if (!/^[\da-f]{64}$/i.test(storedKey)) {
      throw new Error('The local data encryption key file is invalid.');
    }
    return Buffer.from(storedKey, 'hex');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const generatedKey = crypto.randomBytes(32);
  try {
    fs.writeFileSync(keyFile, generatedKey.toString('hex'), { flag: 'wx', mode: 0o600 });
    return generatedKey;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const storedKey = fs.readFileSync(keyFile, 'utf8').trim();
    if (!/^[\da-f]{64}$/i.test(storedKey)) {
      throw new Error('The local data encryption key file is invalid.');
    }
    return Buffer.from(storedKey, 'hex');
  }
}

function getStoredUploadPath(storedName) {
  if (
    typeof storedName !== 'string'
    || !storedName
    || storedName !== path.basename(storedName)
    || storedName.includes('\\')
  ) {
    return null;
  }
  return path.join(uploadsDir, storedName);
}

function migrateUploadedFiles(files) {
  let changed = false;
  for (const file of files) {
    const uploadPath = getStoredUploadPath(file.storedName);
    if (!uploadPath || !fs.existsSync(uploadPath)) continue;
    const storedValue = fs.readFileSync(uploadPath);
    if (!isEncryptedData(storedValue)) {
      writeAtomically(uploadPath, encryptData(storedValue));
      file.status = 'Encrypted';
      changed = true;
    } else {
      decryptData(storedValue);
    }
  }
  if (changed) saveJson(filesFile, files);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function normalizeUserRole(role) {
  const value = String(role || 'viewer').toLowerCase();
  if (value.includes('admin') || value.includes('security')) return 'admin';
  if (value.includes('ops') || value.includes('operation')) return 'ops';
  if (value.includes('research') || value.includes('analyst')) return 'analyst';
  if (value.includes('compliance') || value.includes('legal')) return 'viewer';
  return value || 'viewer';
}

function getSafeUser(user) {
  if (!user) return null;
  const normalizedRole = normalizeUserRole(user.role);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: normalizedRole,
    title: user.title || user.role || normalizedRole || 'Business user',
    country: user.country,
    city: user.city,
    timezone: user.timezone
  };
}

function getUserRank(user) {
  const role = normalizeUserRole(user?.role);
  if (role === 'admin') return 4;
  if (role === 'ops') return 3;
  if (role === 'analyst') return 2;
  return 1;
}

function requireRole(...allowedRoles) {
  return (req, res, next) => {
    const user = req.session?.user;
    const role = normalizeUserRole(user?.role);
    if (!user || !allowedRoles.map((value) => normalizeUserRole(value)).includes(role)) {
      return res.status(403).json({ ok: false, message: 'You do not have access to this area' });
    }
    next();
  };
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseCsvPreview(content, maxRows = 8) {
  content = content.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  let totalRows = 0;

  function finishCell() {
    row.push(cell.trim());
    cell = '';
    afterQuote = false;
  }

  function finishRow() {
    finishCell();
    if (row.some((value) => value !== '')) {
      totalRows += 1;
      if (totalRows > 100_000) throw new Error('CSV exceeds the 100,000-row limit.');
      if (rows.length < maxRows) rows.push(row);
    }
    row = [];
  }

  for (let index = 0; index < content.length; index += 1) {
    const character = content[index];
    if (quoted) {
      if (character === '"' && content[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
        afterQuote = true;
      } else {
        cell += character;
      }
    } else if (afterQuote && character === ',') {
      finishCell();
    } else if (afterQuote && (character === '\n' || character === '\r')) {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      finishRow();
    } else if (afterQuote && /\s/.test(character)) {
      continue;
    } else if (afterQuote) {
      throw new Error('CSV contains unexpected text after a quoted field.');
    } else if (character === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (character === ',') {
      finishCell();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && content[index + 1] === '\n') index += 1;
      finishRow();
    } else if (character === '"') {
      throw new Error('CSV contains a quote inside an unquoted field.');
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error('CSV contains an unclosed quoted field.');
  if (cell || row.length || afterQuote) finishRow();
  return rows;
}

function readCsvPreview(filePath, maxRows = 8) {
  if (!fs.existsSync(filePath)) return [];
  return parseCsvPreview(fs.readFileSync(filePath, 'utf8'), maxRows);
}

function generateId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function resolveRoleFromEmail(email) {
  const local = normalizeEmail(email).split('@')[0] || 'Team member';
  return local.charAt(0).toUpperCase() + local.slice(1);
}

function toCsv(rows) {
  if (!Array.isArray(rows) || !rows.length) return '';
  const headers = Object.keys(rows[0]);
  const escape = (value) => {
    let str = String(value ?? '');
    if (/^[\u0000-\u0020\u007f-\u009f\uFEFF]*[=+\-@]/.test(str)) str = `'${str}`;
    if (str.includes(',') || str.includes('"') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((header) => escape(row[header])).join(','));
  });
  return lines.join('\n');
}

ensureDirectories();
dataEncryptionKey = resolveDataEncryptionKey();

let users = loadJson(usersFile, process.env.NODE_ENV === 'production' ? [] : defaultUsers).map((user) => ({
  ...user,
  role: normalizeUserRole(user.role || user.title),
  title: user.title || user.role || 'Business user'
}));
let clients = loadJson(clientsFile, seededClients);
let fileVault = loadJson(filesFile, seededFiles);
let startupData = loadJson(startupFile, emptyStartupData);
migrateUploadedFiles(fileVault);

if (process.env.NODE_ENV === 'production' && users.length === 0) {
  const adminEmail = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL);
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || '';
  if (!adminEmail || Buffer.byteLength(adminPassword, 'utf8') < 12 || Buffer.byteLength(adminPassword, 'utf8') > 72) {
    throw new Error('Set INITIAL_ADMIN_EMAIL and an INITIAL_ADMIN_PASSWORD of 12 to 72 bytes for the first production start');
  }

  users = [{
    id: generateId('user'),
    name: process.env.INITIAL_ADMIN_NAME || resolveRoleFromEmail(adminEmail),
    email: adminEmail,
    role: 'admin',
    title: 'Workspace administrator',
    country: 'Global',
    city: 'Remote',
    timezone: 'UTC',
    passwordHash: bcrypt.hashSync(adminPassword, 12)
  }];
  saveJson(usersFile, users);
}

const localeCatalog = {
  en: {
    title: 'Sentinel Business Shield',
    subtitle: 'Business Security & Intelligence Command Center',
    language: 'Language',
    overview: 'Overview',
    defense: 'Cyber Defense',
    business: 'Business Intelligence',
    research: 'R&D',
    models: 'AI Models',
    files: 'File Vault',
    clients: 'Client Data',
    risk: 'Risk level',
    posture: 'Security posture',
    alerts: 'Live threat feed',
    audit: 'Immutable audit',
    systems: 'Connected systems',
    score: 'Score',
    summary: 'Executive summary',
    compliance: 'Compliance',
    researchBrief: 'Research brief',
    verified: 'Verified facts',
    assumptions: 'Assumptions',
    actions: 'Recommended actions',
    modelStatus: 'Model status',
    nextReview: 'Review schedule',
    loginTitle: 'Secure business access',
    welcome: 'Welcome back',
    email: 'Business email',
    password: 'Password',
    signIn: 'Sign in',
    register: 'Create account',
    securityNote: 'Sign in with your workspace account. Your business data stays protected behind authentication.',
    locationRisk: 'Location & access risk',
    systemHealth: 'System health',
    riskAnalysis: 'Login analysis',
    uploadCsv: 'Upload CSV',
    fileManagement: 'CSV & file management',
    clientManagement: 'Client management',
    dashboard: 'Dashboard',
    startupManagement: 'Startup Management',
    assistant: 'AI Assistant'
  },
  ja: {
    title: 'Sentinel Business Shield',
    subtitle: 'ビジネスセキュリティとインテリジェンス統制センター',
    language: '言語',
    overview: '概要',
    defense: 'サイバー防御',
    business: '経営分析',
    research: 'R&D',
    models: 'AIモデル',
    files: 'ファイル管理',
    clients: '顧客データ',
    risk: 'リスクレベル',
    posture: 'セキュリティ姿勢',
    alerts: '脅威フィード',
    audit: '監査証跡',
    systems: '接続済みシステム',
    score: 'スコア',
    summary: '経営サマリー',
    compliance: 'コンプライアンス',
    researchBrief: '調査概要',
    verified: '確認済み事実',
    assumptions: '前提',
    actions: '推奨アクション',
    modelStatus: 'モデル状態',
    nextReview: 'レビュー予定',
    loginTitle: '安全なビジネスアクセス',
    welcome: 'おかえりなさい',
    email: 'ビジネスメール',
    password: 'パスワード',
    signIn: 'サインイン',
    register: 'アカウント作成',
    securityNote: 'ワークスペースのアカウントでサインインしてください。ビジネスデータは認証で保護されます。',
    locationRisk: '位置情報とアクセスリスク',
    systemHealth: 'システム健全性',
    riskAnalysis: 'ログイン分析',
    uploadCsv: 'CSVをアップロード',
    fileManagement: 'CSVとファイル管理',
    clientManagement: '顧客管理',
    dashboard: 'ダッシュボード',
    startupManagement: 'スタートアップ管理',
    assistant: 'AIアシスタント'
  },
  hi: {
    title: 'Sentinel Business Shield',
    subtitle: 'व्यवसाय सुरक्षा और बुद्धिमत्ता नियंत्रण केंद्र',
    language: 'भाषा',
    overview: 'अवलोकन',
    defense: 'साइबर डिफेंस',
    business: 'व्यवसाय बुद्धिमत्ता',
    research: 'R&D',
    models: 'एआई मॉडल',
    files: 'फ़ाइल प्रबंधन',
    clients: 'ग्राहक डेटा',
    risk: 'जोखिम स्तर',
    posture: 'सुरक्षा स्थिति',
    alerts: 'खतरे की फीड',
    audit: 'ऑडिट ट्रेल',
    systems: 'कनेक्टेड सिस्टम',
    score: 'स्कोर',
    summary: 'कार्यकारी सारांश',
    compliance: 'अनुपालन',
    researchBrief: 'अनुसंधान सारांश',
    verified: 'सत्यापित तथ्य',
    assumptions: 'धारणा',
    actions: 'सिफ़ारिशें',
    modelStatus: 'मॉडल स्थिति',
    nextReview: 'समीक्षा कार्यक्रम',
    loginTitle: 'सुरक्षित व्यापार एक्सेस',
    welcome: 'फिर से स्वागत है',
    email: 'व्यवसाय ईमेल',
    password: 'पासवर्ड',
    signIn: 'साइन इन',
    register: 'अकाउंट बनाएं',
    securityNote: 'अपने वर्कस्पेस खाते से साइन इन करें। आपका व्यावसायिक डेटा प्रमाणीकरण से सुरक्षित रहता है।',
    locationRisk: 'स्थान और एक्सेस जोखिम',
    systemHealth: 'सिस्टम स्वास्थ्य',
    riskAnalysis: 'लॉगिन विश्लेषण',
    uploadCsv: 'CSV अपलोड करें',
    fileManagement: 'CSV और फ़ाइल प्रबंधन',
    clientManagement: 'ग्राहक प्रबंधन',
    dashboard: 'डैशबोर्ड',
    startupManagement: 'स्टार्टअप प्रबंधन',
    assistant: 'एआई सहायक'
  },
  mr: {
    title: 'Sentinel Business Shield',
    subtitle: 'व्यवसाय सुरक्षा आणि बुद्धिमत्ता नियंत्रण केंद्र',
    language: 'भाषा',
    overview: 'आढावा',
    defense: 'सायबर डिफेंस',
    business: 'व्यवसाय बुद्धिमत्ता',
    research: 'R&D',
    models: 'AI मॉडेल्स',
    files: 'फाइल व्यवस्थापन',
    clients: 'ग्राहक डेटा',
    risk: 'जोखीम स्तर',
    posture: 'सुरक्षा स्थिती',
    alerts: 'धोक्याची फीड',
    audit: 'ऑडिट ट्रेल',
    systems: 'कनेक्टेड सिस्टम',
    score: 'स्कोर',
    summary: 'कार्यकारी सारांश',
    compliance: 'अनुपालन',
    researchBrief: 'संशोधन सारांश',
    verified: 'सत्यापन केलेले तथ्य',
    assumptions: 'धारणे',
    actions: 'शिफारशी',
    modelStatus: 'मॉडल स्थिती',
    nextReview: 'समीक्षा वेळापत्रक',
    loginTitle: 'सुरक्षित व्यवसाय प्रवेश',
    welcome: 'परत स्वागत आहे',
    email: 'व्यवसाय ईमेल',
    password: 'पासवर्ड',
    signIn: 'साइन इन',
    register: 'खाते तयार करा',
    securityNote: 'तुमच्या वर्कस्पेस खात्याने साइन इन करा. तुमचा व्यवसाय डेटा प्रमाणीकरणाने संरक्षित आहे.',
    locationRisk: 'स्थान आणि प्रवेश जोखीम',
    systemHealth: 'सिस्टम आरोग्य',
    riskAnalysis: 'लॉगिन विश्लेषण',
    uploadCsv: 'CSV अपलोड करा',
    fileManagement: 'CSV आणि फाइल व्यवस्थापन',
    clientManagement: 'ग्राहक व्यवस्थापन',
    dashboard: 'डॅशबोर्ड',
    startupManagement: 'स्टार्टअप व्यवस्थापन',
    assistant: 'AI सहाय्यक'
  }
};

const securityDashboard = {
  score: 87,
  riskLevel: 'Watch',
  posture: 'Strong posture with rising API surveillance',
  systems: [
    { name: 'Website', status: 'Healthy', value: '99.9%' },
    { name: 'Cloud Storage', status: 'Protected', value: 'Secure' },
    { name: 'Database', status: 'Monitored', value: 'Live' },
    { name: 'Email', status: 'MFA', value: 'Enabled' },
    { name: 'API Services', status: 'Watch', value: '2 alerts' },
    { name: 'Payment Systems', status: 'Validated', value: 'PCI' },
    { name: 'Endpoint Fleet', status: 'Patch-ready', value: '91%' }
  ],
  alerts: [
    { severity: 'Critical', asset: 'Admin Account', evidence: 'Impossible travel + new device signature', confidence: '99%', action: 'Force MFA and revoke sessions', automatic: true },
    { severity: 'High', asset: 'API Gateway', evidence: '443 failed auth bursts from 3 regions', confidence: '96%', action: 'Throttle and isolate traffic', automatic: true },
    { severity: 'Medium', asset: 'Finance Workspace', evidence: 'Unusual export from payroll report', confidence: '89%', action: 'Review export permissions', automatic: false },
    { severity: 'Low', asset: 'Customer Portal', evidence: 'Repeated password reset attempts', confidence: '82%', action: 'Notify user and monitor', automatic: true }
  ],
  auditTrail: [
    'Finance export was approved through policy review and custody chain validation.',
    'IAM access review triggered after privilege drift was detected in admin cohort.',
    'Database backup validation completed and retention policy confirmed.',
    'API anomaly auto-contained with no customer-facing data loss.',
    'MFA adoption reached 94% organization-wide across production systems.'
  ],
  compliance: [
    { label: 'MFA adoption', value: 94 },
    { label: 'Backup health', value: 98 },
    { label: 'Patch compliance', value: 91 },
    { label: 'Encryption status', value: 97 }
  ],
  timelines: [
    '14:00 — impossible travel alert blocked from Singapore and Berlin',
    '12:25 — bulk export flagged in finance workspace',
    '09:10 — malicious IP reputation matched API gateway traffic',
    '07:45 — endpoint malware signature quarantined on two laptops'
  ],
  sentiment: [
    { label: 'Suspicious logins', value: 17 },
    { label: 'Failed attempts', value: 143 },
    { label: 'Blocked exports', value: 6 },
    { label: 'Policy matches', value: 31 }
  ]
};

const businessDashboard = {
  overview: {
    revenue: '$1.84M',
    runway: '18 months',
    cashFlow: '+$186K',
    churn: '6.4%',
    ltv: '$12.8K',
    pipeline: '$720K'
  },
  performance: [
    { label: 'User acquisition', value: '+22%' },
    { label: 'Trial conversion', value: '34%' },
    { label: 'Product usage', value: '74%' },
    { label: 'NPS', value: '49' }
  ],
  opportunities: [
    { name: 'Enterprise onboarding', score: 92, note: 'Strong retention potential' },
    { name: 'AI assistant add-on', score: 88, note: 'High fit with product roadmap' },
    { name: 'Partner channel', score: 81, note: 'Regional expansion opportunity' },
    { name: 'SMB security package', score: 86, note: 'Low CAC, recurring revenue' }
  ],
  research: {
    verifiedFacts: [
      'Japanese SMBs are prioritizing SaaS security, data residency, and region-aware compliance controls.',
      'Customer churn is concentrated in delayed onboarding steps and weak support response.',
      'High-intent trials correlate with integrations and fast deployment support.'
    ],
    assumptions: [
      'AI workflow automation demand is likely to rise in the next two quarters.',
      'Enterprise buyers may prefer bundled compliance support with transparent reporting.',
      'Mid-market price sensitivity remains moderate where onboarding time is short.'
    ],
    actions: [
      'Launch a guided onboarding bundle with step-by-step implementation support.',
      'Prioritize multifactor enforcement and audit export controls for enterprise accounts.',
      'Build a Japanese-language reporting pack and partner outreach kit.'
    ]
  }
};

const mlModels = {
  security: [
    { name: 'Isolation Forest', status: 'Healthy', precision: '93%' },
    { name: 'Autoencoder', status: 'Watch', precision: '90%' },
    { name: 'Random Forest', status: 'Healthy', precision: '95%' },
    { name: 'Time-series anomaly', status: 'Healthy', precision: '92%' }
  ],
  business: [
    { name: 'Churn prediction', status: 'Healthy', precision: '88%' },
    { name: 'CLV model', status: 'Healthy', precision: '86%' },
    { name: 'Forecasting', status: 'Watch', precision: '84%' },
    { name: 'Opportunity scoring', status: 'Healthy', precision: '91%' }
  ]
};

const geoRiskLocations = [
  { city: 'Tokyo', country: 'Japan', risk: 'Low', score: 18, signal: 'Trusted dev network' },
  { city: 'Singapore', country: 'Singapore', risk: 'Medium', score: 43, signal: 'Unusual token reuse' },
  { city: 'New York', country: 'USA', risk: 'Medium', score: 52, signal: 'New device + VPN' },
  { city: 'Bengaluru', country: 'India', risk: 'Low', score: 22, signal: 'Operational baseline' }
];

const fundingPlan = {
  totalCapital: '$2.4M',
  runway: '18 months',
  burnRate: '$70K / month',
  reserve: '$460K',
  locationBreakdown: [
    { city: 'Tokyo', country: 'Japan', allocated: '$840K', risk: 'Low', roi: '18.4%' },
    { city: 'Singapore', country: 'Singapore', allocated: '$620K', risk: 'Medium', roi: '16.1%' },
    { city: 'New York', country: 'USA', allocated: '$540K', risk: 'Medium', roi: '15.3%' },
    { city: 'Bengaluru', country: 'India', allocated: '$400K', risk: 'Low', roi: '20.8%' }
  ],
  recommendedMoves: [
    'Shift 12% of reserve into Tokyo expansion and compliance automation.',
    'Use Singapore as the regional operations hub for customer support and infrastructure.',
    'Keep a risk reserve in Bengaluru to guard against hiring and market volatility.',
    'Secure all financial and client records with encrypted vaulting and regional access rules.'
  ]
};

const dashboardData = {
  organization: 'Northstar Commerce',
  summary: 'Early-stage SaaS company with strong product-market fit and elevated security watch-level risk.',
  nextReview: 'Due in 4 days',
  security: securityDashboard,
  business: businessDashboard,
  research: {
    focus: 'AI workflow automation for SaaS operations',
    findings: businessDashboard.research,
    sources: ['Industry market intelligence', 'Customer interviews', 'Product analytics', 'Competitor monitoring']
  },
  models: mlModels,
  locationRisk: geoRiskLocations,
  securityControls: [
    'Adaptive MFA with biometric challenge',
    'Device trust validation and session binding',
    'Conditional access by region, risk score, and time zone',
    'Immutable audit trails and forensic timeline review'
  ]
};

app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'self'"]
    }
  }
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '64kb', parameterLimit: 100 }));
if (process.env.TRUST_PROXY === '1') {
  app.set('trust proxy', 1);
}
app.use(
  session({
    secret: sessionSecret || 'sentinel-business-shield-development-only',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 8
    }
  })
);

app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Too many requests. Please slow down.' }
}));
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

const publicSiteCheckLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Website check limit reached. Try again in 15 minutes.' }
});

const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  message: { ok: false, message: 'Too many authentication attempts. Try again in 15 minutes.' }
});

function isPublicRegistrationAllowed(nodeEnv = process.env.NODE_ENV) {
  return nodeEnv !== 'production';
}

function establishAuthenticatedSession(req, res, user, statusCode = 200) {
  req.session.regenerate((error) => {
    if (error) {
      console.error('Unable to rotate the session after authentication.');
      return res.status(500).json({ ok: false, message: 'Unable to start a secure session. Please try again.' });
    }

    req.session.user = {
      ...user,
      role: normalizeUserRole(user.role),
      title: user.title || user.role || 'Business user'
    };
    req.session.save((saveError) => {
      if (saveError) {
        console.error('Unable to save the authenticated session.');
        return res.status(500).json({ ok: false, message: 'Unable to start a secure session. Please try again.' });
      }
      return res.status(statusCode).json({ ok: true, user: getSafeUser(req.session.user) });
    });
  });
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'text/csv' || /\.csv$/i.test(file.originalname)) {
      cb(null, true);
      return;
    }
    cb(new Error('Only CSV files are allowed.'));
  }
});

function ensureAuthenticated(req, res, next) {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ ok: false, message: 'Authentication required' });
  }
  next();
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'healthy',
    service: 'Sentinel Business Shield',
    authenticated: false
  });
});

app.post('/api/public/site-check', publicSiteCheckLimit, async (req, res) => {
  if (req.body?.authorized !== true) {
    return res.status(400).json({ ok: false, message: 'Confirm that you own or are authorized to check this website.' });
  }

  const submittedUrl = String(req.body?.url || '').trim();
  if (!submittedUrl || submittedUrl.length > 2048) {
    return res.status(400).json({ ok: false, message: 'Enter a valid website address.' });
  }

  let target;
  try {
    target = new URL(submittedUrl);
  } catch {
    return res.status(400).json({ ok: false, message: 'Enter a complete website address, such as https://example.com.' });
  }

  const hostname = target.hostname.toLowerCase().replace(/\.$/, '');
  const blockedSuffixes = ['.localhost', '.local', '.internal', '.test', '.invalid', '.example'];
  if (
    !['http:', 'https:'].includes(target.protocol)
    || target.username
    || target.password
    || target.port
    || target.hash
    || !hostname.includes('.')
    || hostname === 'localhost'
    || blockedSuffixes.some((suffix) => hostname.endsWith(suffix))
    || isIP(hostname)
  ) {
    return res.status(400).json({ ok: false, message: 'Only public domain websites on standard HTTP or HTTPS ports can be checked.' });
  }

  let addresses;
  try {
    addresses = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    return res.status(422).json({ ok: false, message: 'The website domain could not be resolved. Check the address and try again.' });
  }

  if (!addresses.length || addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    return res.status(400).json({ ok: false, message: 'This website does not resolve exclusively to public addresses and cannot be checked.' });
  }

  const approvedAddress = addresses.find(({ family }) => family === 4) || addresses[0];
  const client = target.protocol === 'https:' ? https : http;
  const startedAt = Date.now();

  const result = await new Promise((resolve) => {
    let completed = false;
    const finish = (value) => {
      if (completed) return;
      completed = true;
      resolve(value);
    };

    const request = client.request({
      protocol: target.protocol,
      hostname,
      port: target.protocol === 'https:' ? 443 : 80,
      method: 'GET',
      path: `${target.pathname}${target.search}`,
      headers: {
        Host: target.host,
        'User-Agent': 'SentinelBusinessShield-SiteCheck/1.0',
        Accept: 'text/html,application/xhtml+xml,*/*;q=0.5',
        Range: 'bytes=0-0',
        Connection: 'close'
      },
      lookup: (_host, _options, callback) => {
        callback(null, approvedAddress.address, approvedAddress.family);
      }
    }, (response) => {
      const headers = response.headers;
      const isHttps = target.protocol === 'https:';
      const checks = [
        { name: 'HTTPS connection', passed: isHttps, detail: isHttps ? 'Secure HTTPS transport used' : 'Site was checked over unencrypted HTTP' },
        { name: 'HSTS policy', passed: isHttps && Boolean(headers['strict-transport-security']), detail: isHttps && headers['strict-transport-security'] ? 'Present' : 'Not detected' },
        { name: 'Content Security Policy', passed: Boolean(headers['content-security-policy']), detail: headers['content-security-policy'] ? 'Present' : 'Not detected' },
        { name: 'Content type protection', passed: headers['x-content-type-options']?.toLowerCase() === 'nosniff', detail: headers['x-content-type-options']?.toLowerCase() === 'nosniff' ? 'nosniff enabled' : 'nosniff not detected' },
        { name: 'Referrer policy', passed: Boolean(headers['referrer-policy']), detail: headers['referrer-policy'] || 'Not detected' }
      ];

      const siteResult = {
        ok: true,
        hostname,
        protocol: target.protocol.slice(0, -1),
        statusCode: response.statusCode || 0,
        statusMessage: response.statusMessage || 'Unknown',
        reachable: (response.statusCode || 0) < 500,
        responseTimeMs: Date.now() - startedAt,
        contentType: String(headers['content-type'] || 'Not reported').slice(0, 120),
        checks,
        note: 'One request only; redirects are not followed. Header observations are informational, not a penetration test or a complete security audit.'
      };
      response.destroy();
      finish(siteResult);
    });

    request.setTimeout(8000, () => {
      request.destroy(new Error('timeout'));
    });
    request.on('error', (error) => {
      finish({
        ok: false,
        message: error.message === 'timeout'
          ? 'The website took too long to respond. Try again later.'
          : 'The website could not be reached over HTTP or HTTPS.'
      });
    });
    request.end();
  });

  if (!result.ok) {
    return res.status(502).json(result);
  }
  return res.json(result);
});

app.get('/api/auth/me', (req, res) => {
  const user = req.session?.user ? getSafeUser(req.session.user) : null;
  res.json({ ok: true, user });
});

app.get('/api/auth/config', (_req, res) => {
  res.json({ registrationEnabled: isPublicRegistrationAllowed() });
});

app.post('/api/auth/register', authRateLimit, (req, res) => {
  if (!isPublicRegistrationAllowed()) {
    return res.status(403).json({ ok: false, message: 'Public registration is disabled. Ask your workspace administrator for an account.' });
  }

  const name = String(req.body?.name || '').trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (
    !email
    || email.length > 254
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || name.length > 100
    || Buffer.byteLength(password, 'utf8') < 12
    || Buffer.byteLength(password, 'utf8') > 72
  ) {
    return res.status(400).json({ ok: false, message: 'Provide a valid email, a name up to 100 characters, and a password between 12 and 72 bytes.' });
  }

  if (users.some((user) => normalizeEmail(user.email) === email)) {
    return res.status(409).json({ ok: false, message: 'An account with this email already exists' });
  }

  const newUser = {
    id: generateId('user'),
    name: name || resolveRoleFromEmail(email),
    email,
    role: 'viewer',
    title: 'Business user',
    country: 'Global',
    city: 'Remote',
    timezone: 'UTC',
    passwordHash: bcrypt.hashSync(password, 12)
  };

  const updatedUsers = [...users, newUser];
  saveJson(usersFile, updatedUsers);
  users = updatedUsers;
  return establishAuthenticatedSession(req, res, newUser, 201);
});

app.post('/api/auth/login', authRateLimit, (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  const user = users.find((candidate) => normalizeEmail(candidate.email) === email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ ok: false, message: 'Invalid email or password' });
  }

  return establishAuthenticatedSession(req, res, user);
});

app.post('/api/auth/logout', (req, res) => {
  if (req.session) {
    req.session.destroy(() => {
      res.json({ ok: true });
    });
    return;
  }
  res.json({ ok: true });
});

app.get('/api/locales/:locale', (req, res) => {
  const locale = String(req.params.locale || 'en').toLowerCase();
  const payload = localeCatalog[locale] || localeCatalog.en;
  res.json({ locale, strings: payload });
});

app.get('/api/assistant/status', ensureAuthenticated, (_req, res) => {
  res.json({ configured: Boolean(process.env.AI_API_KEY) });
});

app.post('/api/assistant/chat', ensureAuthenticated, async (req, res) => {
  const apiKey = process.env.AI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      ok: false,
      message: 'AI chat is not configured. Set AI_API_KEY on the server and restart the app.'
    });
  }

  const messages = req.body?.messages;
  if (
    !Array.isArray(messages)
    || messages.length === 0
    || messages.length > 20
    || messages[messages.length - 1]?.role !== 'user'
    || messages.some((message) => (
      !message
      || !['user', 'assistant'].includes(message.role)
      || typeof message.content !== 'string'
      || message.content.trim().length === 0
      || message.content.length > 4000
    ))
  ) {
    return res.status(400).json({ ok: false, message: 'Provide up to 20 valid chat messages, ending with your message.' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(process.env.AI_API_URL || 'https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.AI_MODEL || 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: 'You are a practical startup operations and security assistant. Give clear, concise, general guidance. Do not claim access to this app, its records, or current market facts unless the user provides them. Do not present financial, legal, or security guidance as professional advice; recommend qualified professionals for consequential decisions. Remind users not to share passwords, API keys, or sensitive client data.'
          },
          ...messages.map(({ role, content }) => ({ role, content: content.trim() }))
        ],
        max_tokens: 700
      }),
      signal: controller.signal
    });

    if (!response.ok) {
      console.error(`AI provider request failed with HTTP ${response.status}`);
      return res.status(502).json({ ok: false, message: 'The AI provider could not complete the request. Please try again later.' });
    }

    const result = await response.json();
    const reply = result.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      console.error('AI provider returned an empty or invalid response');
      return res.status(502).json({ ok: false, message: 'The AI provider returned an invalid response.' });
    }

    return res.json({ ok: true, reply: reply.trim() });
  } catch (error) {
    if (error.name === 'AbortError') {
      return res.status(504).json({ ok: false, message: 'The AI request timed out. Please try again.' });
    }
    console.error('AI provider request failed:', error.message);
    return res.status(502).json({ ok: false, message: 'The AI provider is currently unavailable. Please try again later.' });
  } finally {
    clearTimeout(timeout);
  }
});

app.get('/api/management', ensureAuthenticated, (_req, res) => {
  res.json(startupData);
});

app.put('/api/management/finance', ensureAuthenticated, requireRole('admin', 'ops'), (req, res) => {
  const { cashBalance, monthlyExpenses, monthlyRevenue } = req.body || {};
  const values = [cashBalance, monthlyExpenses, monthlyRevenue];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12)) {
    return res.status(400).json({ ok: false, message: 'Enter valid non-negative financial values.' });
  }

  startupData.finance = { cashBalance, monthlyExpenses, monthlyRevenue };
  saveJson(startupFile, startupData);
  return res.json({ ok: true, finance: startupData.finance });
});

app.post('/api/management/tasks', ensureAuthenticated, requireRole('admin', 'ops'), (req, res) => {
  const title = String(req.body?.title || '').trim();
  const priority = String(req.body?.priority || 'medium').toLowerCase();
  if (!title || title.length > 160 || !['low', 'medium', 'high'].includes(priority)) {
    return res.status(400).json({ ok: false, message: 'Provide a work item up to 160 characters and a valid priority.' });
  }

  const task = {
    id: generateId('task'),
    title,
    priority,
    status: 'planned',
    createdAt: new Date().toISOString()
  };
  startupData.tasks.unshift(task);
  saveJson(startupFile, startupData);
  return res.status(201).json({ ok: true, task });
});

app.patch('/api/management/tasks/:id', ensureAuthenticated, requireRole('admin', 'ops'), (req, res) => {
  const task = startupData.tasks.find((item) => item.id === req.params.id);
  if (!task) {
    return res.status(404).json({ ok: false, message: 'Work item not found.' });
  }

  const status = String(req.body?.status || '');
  if (!['planned', 'in_progress', 'done'].includes(status)) {
    return res.status(400).json({ ok: false, message: 'Choose a valid work item status.' });
  }

  task.status = status;
  saveJson(startupFile, startupData);
  return res.json({ ok: true, task });
});

app.get('/api/risk-analysis', (_req, res) => {
  res.json({ locations: geoRiskLocations, controls: dashboardData.securityControls });
});

app.get('/api/files', ensureAuthenticated, (_req, res) => {
  res.json({
    totalFiles: fileVault.length,
    protectedFiles: fileVault.filter((item) => item.status === 'Encrypted' || item.status === 'Protected').length,
    files: fileVault
  });
});

app.get('/api/users', ensureAuthenticated, requireRole('admin', 'ops'), (_req, res) => {
  res.json({
    totalUsers: users.length,
    users: users.map((user) => getSafeUser(user))
  });
});

app.post('/api/admin/users', ensureAuthenticated, requireRole('admin'), (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');
  const role = String(req.body?.role || 'viewer').toLowerCase();
  if (
    !name
    || name.length > 100
    || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    || email.length > 254
    || Buffer.byteLength(password, 'utf8') < 12
    || Buffer.byteLength(password, 'utf8') > 72
    || !['ops', 'analyst', 'viewer'].includes(role)
  ) {
    return res.status(400).json({ ok: false, message: 'Provide a valid name, email, password between 12 and 72 bytes, and role (ops, analyst, or viewer).' });
  }
  if (users.some((user) => normalizeEmail(user.email) === email)) {
    return res.status(409).json({ ok: false, message: 'An account with this email already exists.' });
  }

  const newUser = {
    id: generateId('user'),
    name,
    email,
    role,
    title: role === 'ops' ? 'Operations' : role === 'analyst' ? 'Research Analyst' : 'Business user',
    country: 'Global',
    city: 'Remote',
    timezone: 'UTC',
    passwordHash: bcrypt.hashSync(password, 12)
  };
  const updatedUsers = [...users, newUser];
  saveJson(usersFile, updatedUsers);
  users = updatedUsers;
  return res.status(201).json({ ok: true, user: getSafeUser(newUser) });
});

app.get('/api/admin/overview', ensureAuthenticated, requireRole('admin', 'ops'), (req, res) => {
  const userSummary = users.map((user) => ({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    title: user.title || user.role || 'Business user'
  }));

  res.json({
    currentUser: getSafeUser(req.session.user),
    overview: {
      totalUsers: users.length,
      totalClients: clients.length,
      totalFiles: fileVault.length,
      protectedFiles: fileVault.filter((item) => item.status === 'Encrypted' || item.status === 'Protected').length,
      activeRiskAlerts: securityDashboard.alerts.filter((alert) => alert.severity === 'Critical' || alert.severity === 'High').length
    },
    users: userSummary,
    latestFiles: fileVault.slice(0, 5)
  });
});

app.get('/api/files/:id/download', ensureAuthenticated, (req, res) => {
  const file = fileVault.find((item) => item.id === req.params.id);
  if (!file) {
    return res.status(404).json({ ok: false, message: 'File not found' });
  }

  const uploadPath = getStoredUploadPath(file.storedName);
  const csvContent = uploadPath && fs.existsSync(uploadPath)
    ? decryptData(fs.readFileSync(uploadPath)).toString('utf8')
    : (Array.isArray(file.preview) ? file.preview.map((row) => row.join(',')).join('\n') : '');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.attachment(path.basename(file.name));
  return res.send(csvContent || '');
});

app.get('/api/exports/clients.csv', ensureAuthenticated, requireRole('admin', 'ops', 'analyst'), (_req, res) => {
  const csv = toCsv(clients.map((client) => ({
    name: client.name,
    industry: client.industry,
    owner: client.owner,
    region: client.region,
    status: client.status,
    risk: client.risk
  })));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clients.csv"');
  res.send(csv);
});

app.get('/api/exports/files.csv', ensureAuthenticated, requireRole('admin', 'ops', 'analyst'), (_req, res) => {
  const csv = toCsv(fileVault.map((file) => ({
    name: file.name,
    owner: file.owner,
    size: file.size,
    status: file.status,
    risk: file.risk,
    updated: file.updated
  })));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="files.csv"');
  res.send(csv);
});

app.post('/api/files/upload', ensureAuthenticated, requireRole('admin', 'ops'), (req, res) => {
  upload.single('file')(req, res, (error) => {
    if (error) {
      return res.status(400).json({ ok: false, message: error.message || 'File upload failed' });
    }

    const uploadedFile = req.file;
    if (!uploadedFile) {
      return res.status(400).json({ ok: false, message: 'CSV file is required' });
    }

    let preview;
    try {
      const csvContent = new TextDecoder('utf-8', { fatal: true }).decode(uploadedFile.buffer);
      preview = parseCsvPreview(csvContent, 8);
      if (!preview.length) throw new Error('CSV must contain a header row and at least one non-empty field.');
    } catch (parseError) {
      return res.status(400).json({ ok: false, message: parseError.message || 'The CSV file is malformed.' });
    }

    const storedName = `${randomUUID()}.csv`;
    const uploadPath = getStoredUploadPath(storedName);
    try {
      writeAtomically(uploadPath, encryptData(uploadedFile.buffer));
    } catch (storageError) {
      console.error('Unable to store an encrypted CSV upload.');
      return res.status(500).json({ ok: false, message: 'The CSV could not be stored securely. Please try again.' });
    }

    const entry = {
      id: generateId('file'),
      name: path.basename(uploadedFile.originalname).replace(/[\r\n"]/g, '_'),
      storedName,
      size: formatBytes(uploadedFile.size),
      owner: req.session.user.name,
      status: 'Encrypted',
      updated: 'just now',
      risk: 'Low',
      preview
    };

    const updatedFiles = [entry, ...fileVault];
    try {
      saveJson(filesFile, updatedFiles);
      fileVault = updatedFiles;
    } catch (storageError) {
      fs.unlinkSync(uploadPath);
      console.error('Unable to save metadata for an encrypted CSV upload.');
      return res.status(500).json({ ok: false, message: 'The CSV could not be saved. Please try again.' });
    }
    return res.json({ ok: true, file: entry });
  });
});

app.post('/api/files/:id/secure', ensureAuthenticated, requireRole('admin', 'ops'), (req, res) => {
  const file = fileVault.find((item) => item.id === req.params.id);
  if (!file) {
    return res.status(404).json({ ok: false, message: 'File not found' });
  }

  const uploadPath = getStoredUploadPath(file.storedName);
  if (uploadPath && fs.existsSync(uploadPath)) {
    const storedValue = fs.readFileSync(uploadPath);
    if (isEncryptedData(storedValue)) {
      decryptData(storedValue);
    } else {
      const legacyContent = storedValue.toString('utf8');
      parseCsvPreview(legacyContent, 8);
      writeAtomically(uploadPath, encryptData(storedValue));
    }
  }
  file.status = 'Encrypted';
  file.risk = 'Low';
  file.updated = 'just now';
  saveJson(filesFile, fileVault);
  res.json({ ok: true, file });
});

app.get('/api/clients', ensureAuthenticated, (_req, res) => {
  res.json({
    totalClients: clients.length,
    trustedClients: clients.filter((client) => client.status === 'Trusted' || client.status === 'Verified').length,
    clients
  });
});

app.post('/api/clients', ensureAuthenticated, requireRole('admin', 'ops'), (req, res) => {
  const { name, industry } = req.body || {};
  const owner = String(req.body?.owner || req.session.user.name).trim();
  const region = String(req.body?.region || 'Global').trim();
  const status = String(req.body?.status || 'Verified');
  const risk = String(req.body?.risk || 'Low');
  if (
    typeof name !== 'string'
    || !name.trim()
    || name.trim().length > 120
    || typeof industry !== 'string'
    || !industry.trim()
    || industry.trim().length > 100
    || owner.length > 100
    || region.length > 100
    || !['Trusted', 'Needs review', 'Verified'].includes(status)
    || !['Low', 'Medium', 'High'].includes(risk)
  ) {
    return res.status(400).json({ ok: false, message: 'Provide a valid client name, industry, owner, region, status, and risk level.' });
  }

  const client = {
    id: generateId('client'),
    name: name.trim(),
    industry: String(industry).trim(),
    owner,
    region,
    status,
    risk
  };

  clients.unshift(client);
  saveJson(clientsFile, clients);
  return res.json({ ok: true, client });
});

app.get('/api/dashboard/all', ensureAuthenticated, (req, res) => {
  res.json({
    organization: dashboardData.organization,
    summary: dashboardData.summary,
    nextReview: dashboardData.nextReview,
    security: securityDashboard,
    business: businessDashboard,
    research: dashboardData.research,
    models: mlModels,
    locationRisk: geoRiskLocations,
    securityControls: dashboardData.securityControls,
    files: fileVault,
    clients,
    currentUser: getSafeUser(req.session.user)
  });
});

app.get('/api/dashboard/security', ensureAuthenticated, (_req, res) => {
  res.json(securityDashboard);
});

app.get('/api/dashboard/business', ensureAuthenticated, (_req, res) => {
  res.json(businessDashboard);
});

app.get('/api/dashboard/summary', ensureAuthenticated, (_req, res) => {
  res.json({
    organization: dashboardData.organization,
    summary: dashboardData.summary,
    watch: 'Watch',
    nextReview: dashboardData.nextReview
  });
});

app.get('/api/research', ensureAuthenticated, (_req, res) => {
  res.json(dashboardData.research);
});

app.get('/api/ml', ensureAuthenticated, (_req, res) => {
  res.json(mlModels);
});

app.get(/^(?!\/api).*$/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((error, _req, res, _next) => {
  if (Number(error?.status) === 413) {
    return res.status(413).json({ ok: false, message: 'Request body exceeds the allowed size.' });
  }
  if (Number(error?.status) >= 400 && Number(error?.status) < 500) {
    return res.status(Number(error.status)).json({ ok: false, message: 'Invalid request.' });
  }
  console.error('Unhandled request error:', error);
  return res.status(500).json({ ok: false, message: 'Internal server error.' });
});

if (require.main === module) {
  app.listen(port, () => {
    console.log(`Sentinel Business Shield running on http://localhost:${port}`);
  });
}

module.exports = {
  app,
  loadJson,
  saveJson,
  readCsvPreview,
  toCsv,
  encryptData,
  decryptData,
  isEncryptedData,
  migrateUploadedFiles,
  isPublicRegistrationAllowed
};
