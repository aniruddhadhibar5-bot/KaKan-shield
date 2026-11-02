const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
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

function loadJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    return JSON.parse(JSON.stringify(fallback));
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = raw ? JSON.parse(raw) : fallback;
    return parsed;
  } catch (error) {
    fs.writeFileSync(filePath, JSON.stringify(fallback, null, 2));
    return JSON.parse(JSON.stringify(fallback));
  }
}

function saveJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
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

function readCsvPreview(filePath, maxRows = 8) {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf8').replace(/\r/g, '');
  const lines = content.split('\n').filter((line) => line.trim() !== '').slice(0, maxRows);
  return lines.map((line) => {
    const cells = line.split(',');
    return cells.map((cell) => cell.trim());
  });
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
    const str = String(value ?? '');
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

let users = loadJson(usersFile, process.env.NODE_ENV === 'production' ? [] : defaultUsers).map((user) => ({
  ...user,
  role: normalizeUserRole(user.role || user.title),
  title: user.title || user.role || 'Business user'
}));
let clients = loadJson(clientsFile, seededClients);
let fileVault = loadJson(filesFile, seededFiles);
let startupData = loadJson(startupFile, emptyStartupData);

if (process.env.NODE_ENV === 'production' && users.length === 0) {
  const adminEmail = normalizeEmail(process.env.INITIAL_ADMIN_EMAIL);
  const adminPassword = process.env.INITIAL_ADMIN_PASSWORD || '';
  if (!adminEmail || adminPassword.length < 12) {
    throw new Error('Set INITIAL_ADMIN_EMAIL and an INITIAL_ADMIN_PASSWORD of at least 12 characters for the first production start');
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

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
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

const publicSiteCheckLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 6,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, message: 'Website check limit reached. Try again in 15 minutes.' }
});

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
      const safeName = file.originalname.replace(/\s+/g, '-');
      cb(null, `${Date.now()}-${safeName}`);
    }
  }),
  limits: { fileSize: 10 * 1024 * 1024 },
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
    authenticated: false,
    storage: 'local-json',
    userCount: users.length,
    clientCount: clients.length,
    fileCount: fileVault.length
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

app.post('/api/auth/register', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  if (!email || !password) {
    return res.status(400).json({ ok: false, message: 'Email and password are required' });
  }

  if (password.length < 8) {
    return res.status(400).json({ ok: false, message: 'Password must be at least 8 characters' });
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
    passwordHash: bcrypt.hashSync(password, 10)
  };

  users.push(newUser);
  saveJson(usersFile, users);
  req.session.user = newUser;

  return res.status(201).json({ ok: true, user: getSafeUser(newUser) });
});

app.post('/api/auth/login', (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = String(req.body?.password || '');

  const user = users.find((candidate) => normalizeEmail(candidate.email) === email);
  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return res.status(401).json({ ok: false, message: 'Invalid email or password' });
  }

  req.session.user = {
    ...user,
    role: normalizeUserRole(user.role),
    title: user.title || user.role || 'Business user'
  };
  return res.json({ ok: true, user: getSafeUser(req.session.user) });
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

app.put('/api/management/finance', ensureAuthenticated, (req, res) => {
  const { cashBalance, monthlyExpenses, monthlyRevenue } = req.body || {};
  const values = [cashBalance, monthlyExpenses, monthlyRevenue];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1e12)) {
    return res.status(400).json({ ok: false, message: 'Enter valid non-negative financial values.' });
  }

  startupData.finance = { cashBalance, monthlyExpenses, monthlyRevenue };
  saveJson(startupFile, startupData);
  return res.json({ ok: true, finance: startupData.finance });
});

app.post('/api/management/tasks', ensureAuthenticated, (req, res) => {
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

app.patch('/api/management/tasks/:id', ensureAuthenticated, (req, res) => {
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

  const safeName = file.storedName || file.name;
  const uploadPath = path.join(uploadsDir, safeName);
  const csvContent = fs.existsSync(uploadPath)
    ? fs.readFileSync(uploadPath, 'utf8')
    : (Array.isArray(file.preview) ? file.preview.map((row) => row.join(',')).join('\n') : '');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
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

app.post('/api/files/upload', ensureAuthenticated, (req, res) => {
  upload.single('file')(req, res, (error) => {
    if (error) {
      return res.status(400).json({ ok: false, message: error.message || 'File upload failed' });
    }

    const uploadedFile = req.file;
    if (!uploadedFile) {
      return res.status(400).json({ ok: false, message: 'CSV file is required' });
    }

    const preview = readCsvPreview(uploadedFile.path, 8);
    const entry = {
      id: generateId('file'),
      name: uploadedFile.originalname,
      storedName: uploadedFile.filename,
      size: formatBytes(uploadedFile.size),
      owner: req.session.user.name,
      status: 'Protected',
      updated: 'just now',
      risk: 'Low',
      preview
    };

    fileVault.unshift(entry);
    saveJson(filesFile, fileVault);
    return res.json({ ok: true, file: entry });
  });
});

app.post('/api/files/:id/secure', ensureAuthenticated, (req, res) => {
  const file = fileVault.find((item) => item.id === req.params.id);
  if (!file) {
    return res.status(404).json({ ok: false, message: 'File not found' });
  }

  file.status = file.status === 'Encrypted' ? 'Protected' : 'Encrypted';
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

app.post('/api/clients', ensureAuthenticated, (req, res) => {
  const { name, industry, owner, region, status, risk } = req.body || {};
  if (!name || !industry) {
    return res.status(400).json({ ok: false, message: 'Client name and industry are required' });
  }

  const client = {
    id: generateId('client'),
    name: String(name).trim(),
    industry: String(industry).trim(),
    owner: owner || req.session.user.name,
    region: region || 'Global',
    status: status || 'Verified',
    risk: risk || 'Low'
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
  if (error && error.message) {
    return res.status(400).json({ ok: false, message: error.message });
  }
  return res.status(500).json({ ok: false, message: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Sentinel Business Shield running on http://localhost:${port}`);
});
