const state = {
  locale: 'en',
  strings: {},
  dashboard: null,
  isAuthenticated: false,
  userRole: 'viewer',
  authMode: 'login',
  chatMessages: []
};

function canManageWorkspace() {
  return ['admin', 'ops'].includes(state.userRole);
}

function setWorkspaceRole(role) {
  state.userRole = role || 'viewer';
  document.getElementById('dashboardShell').classList.toggle('read-only', !canManageWorkspace());
  document.getElementById('readOnlyNotice').classList.toggle('hidden', canManageWorkspace());
}

const tabMap = {
  overview: document.getElementById('overviewView'),
  defense: document.getElementById('defenseView'),
  business: document.getElementById('businessView'),
  research: document.getElementById('researchView'),
  models: document.getElementById('modelsView'),
  files: document.getElementById('filesView'),
  clients: document.getElementById('clientsView'),
  management: document.getElementById('managementView'),
  assistant: document.getElementById('assistantView')
};

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[character]);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
}

function showDashboard(show) {
  const publicSiteShell = document.getElementById('publicSiteShell');
  const dashboardShell = document.getElementById('dashboardShell');
  const landing = document.getElementById('publicLanding');
  const workspaceLogin = document.getElementById('workspaceLoginView');
  const isWorkspaceRoute = window.location.pathname.replace(/\/+$/, '') === '/workspace';
  if (publicSiteShell) publicSiteShell.classList.toggle('hidden', show);
  if (landing) landing.classList.toggle('hidden', show || isWorkspaceRoute);
  if (workspaceLogin) workspaceLogin.classList.toggle('hidden', show || !isWorkspaceRoute);
  if (dashboardShell) dashboardShell.classList.toggle('hidden', !show);
}

function setAuthMode(mode) {
  state.authMode = mode;
  const isRegister = mode === 'register';
  const nameField = document.getElementById('nameField');
  const loginButton = document.getElementById('loginButton');
  const authButtons = document.querySelectorAll('.auth-mode-btn');

  authButtons.forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === mode);
  });

  if (nameField) nameField.classList.toggle('hidden', !isRegister);
  if (loginButton) loginButton.textContent = isRegister ? 'Create account' : 'Sign in';
  if (isRegister) {
    setText('loginTitle', 'Create a secure workspace');
    setText('welcomeText', 'Set up your startup access');
  } else {
    setText('loginTitle', state.strings.loginTitle || 'Secure business access');
    setText('welcomeText', state.strings.welcome || 'Welcome back');
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    throw new Error(data.message || 'Request failed');
  }

  return data;
}

function renderLoginInfo(data) {
  const locations = (data && data.locations) || [];
  const controls = (data && data.controls) || [];
  const locationList = document.getElementById('locationRiskList');
  const systemList = document.getElementById('systemHealthList');

  if (locationList) locationList.innerHTML = locations.map((item) => `
    <div class="location-row">
      <div>
        <strong>${item.city}</strong>
        <div class="alert-details">${item.country}</div>
      </div>
      <span class="risk-tag ${item.risk.toLowerCase()}">${item.risk}</span>
      <span class="score-pill">${item.score}</span>
    </div>
  `).join('');

  if (systemList) systemList.innerHTML = controls.map((item) => `
    <div class="health-row">
      <div>${item}</div>
      <span class="state-pill">Active</span>
    </div>
  `).join('');
}

function initLandingGraphs() {
  const line = document.getElementById('signalLine');
  const area = document.getElementById('signalArea');
  const radarShape = document.getElementById('radarShape');
  if (!line || !area || !radarShape) return;

  const axisLabels = {
    '24H': ['00:00', '12:00', '24H'],
    '7D': ['MON', 'THU', 'TODAY'],
    '30D': ['01', '15', '30D']
  };
  let selectedRange = '7D';
  let values = Array.from({ length: 25 }, (_, index) => (
    Math.max(25, Math.min(87, 53 + index * 0.75 + Math.sin(index * 0.68) * 13 + Math.cos(index * 0.31) * 7))
  ));
  let radarValues = [0.78, 0.6, 0.74, 0.48, 0.68];
  const radarPoints = [...document.querySelectorAll('.radar-point')];

  function draw() {
    const points = values.map((value, index) => {
      const x = index * 480 / (values.length - 1);
      const y = 116 - value * 1.08;
      return `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
    line.setAttribute('d', points);
    area.setAttribute('d', `${points} L480 126 L0 126 Z`);
    const latest = Math.round(values[values.length - 1]);
    document.getElementById('signalReadout').textContent = `SIGNAL ${latest}`;
    document.getElementById('chartAxisStart').textContent = axisLabels[selectedRange][0];
    document.getElementById('chartAxisMiddle').textContent = axisLabels[selectedRange][1];
    document.getElementById('chartAxisEnd').textContent = axisLabels[selectedRange][2];

    const centerX = 90;
    const centerY = 90;
    const radius = 68;
    const polygonPoints = radarValues.map((value, index) => {
      const angle = -Math.PI / 2 + index * 2 * Math.PI / radarValues.length;
      const distance = radius * value;
      const x = centerX + Math.cos(angle) * distance;
      const y = centerY + Math.sin(angle) * distance;
      if (radarPoints[index]) {
        radarPoints[index].setAttribute('cx', x.toFixed(1));
        radarPoints[index].setAttribute('cy', y.toFixed(1));
      }
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    radarShape.setAttribute('points', polygonPoints.join(' '));
    radarShape.setAttribute('aria-label', `Illustrative risk radar: ${radarValues.map((value) => Math.round(value * 100)).join(', ')} percent`);
  }

  document.querySelectorAll('.chart-range').forEach((button) => {
    button.addEventListener('click', () => {
      selectedRange = button.dataset.range;
      document.querySelectorAll('.chart-range').forEach((option) => {
        const active = option === button;
        option.classList.toggle('active', active);
        option.setAttribute('aria-pressed', String(active));
      });
      draw();
    });
  });

  draw();
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  window.setInterval(() => {
    if (document.hidden) return;
    const lastValue = values[values.length - 1];
    const nextValue = Math.max(25, Math.min(87, lastValue + (Math.random() - 0.46) * 12));
    values = [...values.slice(1), nextValue];
    radarValues = radarValues.map((value) => Math.max(0.32, Math.min(0.86, value + (Math.random() - 0.5) * 0.08)));
    draw();
  }, 1800);
}

function parseCsvText(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;
  const input = text.replace(/^\uFEFF/, '');

  function finishCell() {
    row.push(cell.trim());
    cell = '';
    afterQuote = false;
  }

  function finishRow() {
    finishCell();
    if (row.some((value) => value !== '')) rows.push(row);
    if (rows.length > 100001) {
      throw new Error('This CSV has too many rows to analyze safely in the browser (maximum 100,000).');
    }
    row = [];
  }

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
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
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      finishRow();
    } else if (afterQuote && /\s/.test(character)) {
      continue;
    } else if (afterQuote) {
      throw new Error('This CSV contains unexpected text after a quoted field.');
    } else if (character === '"' && cell.trim() === '') {
      cell = '';
      quoted = true;
    } else if (character === ',') {
      finishCell();
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && input[index + 1] === '\n') index += 1;
      finishRow();
    } else if (character === '"') {
      throw new Error('This CSV contains a quote inside an unquoted field.');
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error('This CSV contains an unclosed quoted field.');
  if (cell || row.length || afterQuote) finishRow();
  return rows;
}

function renderCsvCheckSummary(file, rows) {
  const results = document.getElementById('csvCheckResult');
  if (!rows.length) throw new Error('No CSV rows were found in that file.');

  const headers = rows[0].map((header) => header.trim());
  const normalizedHeaders = headers.map((header) => header.toLowerCase());
  const emailIndex = normalizedHeaders.findIndex((header) => /e.?mail/.test(header));
  const companyIndex = normalizedHeaders.findIndex((header) => /client|company|customer|account|organization|business.?name/.test(header));
  const records = rows.slice(1).filter((record) => record.some((value) => value !== ''));
  const emailValues = emailIndex < 0
    ? []
    : records.map((record) => (record[emailIndex] || '').trim().toLowerCase()).filter((value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  const uniqueEmails = new Set(emailValues);
  const companyValues = companyIndex < 0
    ? []
    : records.map((record) => (record[companyIndex] || '').trim().toLowerCase()).filter(Boolean);
  const uniqueCompanies = new Set(companyValues);
  const rowsWithMissingValues = records.filter((record) => headers.some((_header, index) => !(record[index] || '').trim())).length;

  const indicators = [
    { label: 'Client records', value: records.length, percent: records.length ? 100 : 0 },
    { label: 'Unique email contacts', value: uniqueEmails.size, percent: records.length ? Math.min(100, uniqueEmails.size / records.length * 100) : 0 },
    { label: 'Unique company names', value: uniqueCompanies.size, percent: records.length ? Math.min(100, uniqueCompanies.size / records.length * 100) : 0 }
  ];
  const quality = records.length ? Math.round((records.length - rowsWithMissingValues) / records.length * 100) : 0;
  results.innerHTML = `
    <div class="csv-result-heading">
      <div><span class="result-eyebrow">LOCAL ANALYSIS COMPLETE</span><strong>${escapeHTML(file.name)}</strong></div>
      <span class="csv-quality">${quality}% complete rows</span>
    </div>
    <div class="csv-indicators">
      ${indicators.map((item) => `
        <div class="csv-indicator">
          <div><span>${item.label}</span><strong>${item.value.toLocaleString()}</strong></div>
          <div class="csv-meter"><span style="width:${item.percent.toFixed(1)}%"></span></div>
        </div>
      `).join('')}
    </div>
    <div class="csv-result-footer">${headers.length} columns detected · ${emailIndex >= 0 ? 'Email column found' : 'No email column detected'} · File stays on this device</div>
  `;
}

async function handlePublicCsv(file) {
  const results = document.getElementById('csvCheckResult');
  results.replaceChildren();
  if (!file || !/\.csv$/i.test(file.name)) {
    results.textContent = 'Choose a .csv file to analyze.';
    return;
  }
  if (file.size > 5 * 1024 * 1024) {
    results.textContent = 'This file is larger than 5 MB. Choose a smaller CSV.';
    return;
  }

  results.textContent = 'Reading and analyzing this file locally…';
  try {
    const rows = parseCsvText(await file.text());
    renderCsvCheckSummary(file, rows);
  } catch (error) {
    results.textContent = error.message || 'This CSV could not be analyzed.';
  }
}

async function handlePublicSiteCheck(event) {
  event.preventDefault();
  const input = document.getElementById('siteCheckUrl');
  const button = document.getElementById('siteCheckButton');
  const results = document.getElementById('siteCheckResult');
  const url = input.value.trim();
  results.replaceChildren();
  button.disabled = true;
  button.textContent = 'Checking your website…';

  try {
    const result = await fetchJson('/api/public/site-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url,
        authorized: document.getElementById('siteCheckAuthorized').checked
      })
    });
    const passingChecks = result.checks.filter((check) => check.passed).length;
    results.innerHTML = `
      <div class="site-result-heading">
        <span class="site-result-mark">${result.reachable ? '✓' : '!'}</span>
        <div><span class="result-eyebrow">${result.reachable ? 'WEBSITE RESPONDED' : 'RESPONSE NEEDS REVIEW'}</span><strong>${escapeHTML(result.hostname)}</strong></div>
        <span class="site-code">${result.statusCode} ${escapeHTML(result.statusMessage)}</span>
      </div>
      <div class="site-result-stats">
        <div><span>Response time</span><strong>${result.responseTimeMs} ms</strong></div>
        <div><span>Transport</span><strong>${escapeHTML(result.protocol.toUpperCase())}</strong></div>
        <div><span>Header signals</span><strong>${passingChecks} / ${result.checks.length}</strong></div>
        <div><span>Content type</span><strong>${escapeHTML(result.contentType)}</strong></div>
      </div>
      <div class="site-check-list">
        ${result.checks.map((check) => `
          <div class="site-check-item">
            <span class="check-indicator ${check.passed ? 'pass' : 'note'}">${check.passed ? '✓' : '–'}</span>
            <span>${escapeHTML(check.name)}</span><small>${escapeHTML(check.detail)}</small>
          </div>
        `).join('')}
      </div>
      <p class="site-result-disclaimer">${escapeHTML(result.note)}</p>
    `;
  } catch (error) {
    results.textContent = error.message || 'The website could not be checked. Review the address and try again.';
  } finally {
    button.disabled = false;
    button.innerHTML = 'Run basic check <span aria-hidden="true">→</span>';
  }
}

function bindPublicCheckup() {
  const siteForm = document.getElementById('siteCheckForm');
  const csvInput = document.getElementById('publicCsvInput');
  const dropZone = document.getElementById('publicCsvDrop');
  siteForm.addEventListener('submit', handlePublicSiteCheck);
  csvInput.addEventListener('change', () => handlePublicCsv(csvInput.files[0]));
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.classList.remove('drag-over');
    handlePublicCsv(event.dataTransfer.files[0]);
  });
}

function renderOverview(data) {
  const security = data.security || {};
  document.getElementById('overviewMetrics').innerHTML = [
    { label: 'Risk level', value: security.riskLevel || 'Watch' },
    { label: 'Security posture', value: `${security.score || 87}` },
    { label: 'Threats today', value: `${(security.alerts || []).length}` },
    { label: 'Systems live', value: `${(security.systems || []).length}` }
  ].map((item) => `
    <div class="metric-box">
      <div class="metric-name">${item.label}</div>
      <div class="metric-value">${item.value}</div>
    </div>
  `).join('');

  document.getElementById('systemsList').innerHTML = (security.systems || []).slice(0, 6).map((item) => `
    <div class="system-row">
      <div>
        <strong>${item.name}</strong>
        <div class="alert-details">${item.value}</div>
      </div>
      <span class="system-status">${item.status}</span>
    </div>
  `).join('');

  document.getElementById('alertFeed').innerHTML = (security.alerts || []).slice(0, 4).map((alert) => `
    <div class="alert-row">
      <div class="card-header">
        <strong>${alert.asset}</strong>
        <span class="alert-severity ${alert.severity.toLowerCase()}">${alert.severity}</span>
      </div>
      <div class="alert-details">${alert.evidence}</div>
      <div class="alert-details">Confidence: ${alert.confidence} · ${alert.action}</div>
    </div>
  `).join('');

  setText('riskLabel', security.riskLevel || 'Watch');
  setText('riskValue', security.riskLevel || 'Watch');
  setText('postureScore', `${security.score || 87}`);
  setText('postureStatus', security.posture || 'Strong posture with rising API surveillance');
  setText('orgName', data.organization || 'Northstar Commerce');
  setText('summaryText', data.summary || 'Early-stage SaaS company with strong fit and elevated watch-level risk.');
  setText('reviewWindow', data.nextReview || 'Due in 4 days');
}

function renderDefense(data) {
  const security = data.security || {};
  const metrics = [
    { label: 'MFA', value: '94%' },
    { label: 'Backup health', value: '98%' },
    { label: 'Patch rate', value: '91%' },
    { label: 'Encrypted', value: '97%' }
  ];

  document.getElementById('defenseMetrics').innerHTML = metrics.map((item) => `
    <div class="metric-box">
      <div class="metric-name">${item.label}</div>
      <div class="metric-value">${item.value}</div>
    </div>
  `).join('');

  document.getElementById('auditTrail').innerHTML = (security.auditTrail || []).map((item) => `<li>${item}</li>`).join('');

  document.getElementById('complianceRows').innerHTML = (security.compliance || []).map((item) => `
    <div class="progress-row">
      <div class="card-header">
        <strong>${item.label}</strong>
        <span>${item.value}%</span>
      </div>
      <div class="progress-track">
        <div class="progress-fill" style="width:${item.value}%"></div>
      </div>
    </div>
  `).join('');

  document.getElementById('incidentTimeline').innerHTML = (security.timelines || []).map((item) => `
    <div class="alert-row">
      <div>${item}</div>
    </div>
  `).join('');
}

function renderBusiness(data) {
  const business = data.business || {};
  const overview = business.overview || {};

  document.getElementById('businessMetrics').innerHTML = [
    { label: 'Revenue', value: overview.revenue || '$1.84M' },
    { label: 'Runway', value: overview.runway || '18 months' },
    { label: 'Cash flow', value: overview.cashFlow || '+$186K' },
    { label: 'LTV', value: overview.ltv || '$12.8K' }
  ].map((item) => `
    <div class="metric-box">
      <div class="metric-name">${item.label}</div>
      <div class="metric-value">${item.value}</div>
    </div>
  `).join('');

  document.getElementById('opportunityList').innerHTML = (business.opportunities || []).map((item) => `
    <div class="opportunity-row">
      <div>
        <strong>${item.name}</strong>
        <div class="alert-details">${item.note}</div>
      </div>
      <span class="score-pill">${item.score}</span>
    </div>
  `).join('');

  const research = business.research || {};
  document.getElementById('researchBrief').innerHTML = `
    <div class="alert-details">
      ${(research.actions || []).slice(0, 3).map((item) => `<div>• ${item}</div>`).join('')}
    </div>
  `;
}

function renderResearch(data) {
  const research = data.research || {};
  const findings = research.findings || {};
  document.getElementById('verifiedFacts').innerHTML = (findings.verifiedFacts || []).map((item) => `<li>${item}</li>`).join('');
  document.getElementById('assumptions').innerHTML = (findings.assumptions || []).map((item) => `<li>${item}</li>`).join('');
  document.getElementById('recommendedActions').innerHTML = (findings.actions || []).map((item) => `
    <div class="action-row">
      <strong>${item}</strong>
    </div>
  `).join('');
}

function renderModels(data) {
  const models = data.models || {};
  document.getElementById('securityModels').innerHTML = (models.security || []).map((model) => `
    <div class="model-row">
      <strong>${model.name}</strong>
      <span class="state-pill ${model.status === 'Watch' ? 'watch' : ''}">${model.status}</span>
      <span class="score-pill">${model.precision}</span>
    </div>
  `).join('');

  document.getElementById('businessModels').innerHTML = (models.business || []).map((model) => `
    <div class="model-row">
      <strong>${model.name}</strong>
      <span class="state-pill ${model.status === 'Watch' ? 'watch' : ''}">${model.status}</span>
      <span class="score-pill">${model.precision}</span>
    </div>
  `).join('');
}

function renderFileVault(files) {
  const list = document.getElementById('fileVaultList');
  if (!list) return;

  list.innerHTML = (files || []).map((file) => `
    <div class="file-row">
      <div class="file-main">
        <strong>${escapeHTML(file.name)}</strong>
        <div class="alert-details">Owner: ${escapeHTML(file.owner)} · Size: ${escapeHTML(file.size)} · Updated: ${escapeHTML(file.updated)}</div>
        <div class="file-preview">
          ${(file.preview || []).slice(0, 3).map((row) => `<span>${(Array.isArray(row) ? row : [row]).map(escapeHTML).join(' | ')}</span>`).join('')}
        </div>
      </div>
      <div class="file-actions">
        <span class="status-tag ${file.status === 'Encrypted' ? 'encrypted' : 'protected'}">${escapeHTML(file.status)}</span>
        ${canManageWorkspace() ? `<button class="mini-btn" data-file-id="${escapeHTML(file.id)}" type="button">${file.status === 'Encrypted' ? 'Verify encryption' : 'Encrypt at rest'}</button>` : ''}
      </div>
    </div>
  `).join('');
}

function renderClientList(clients) {
  const list = document.getElementById('clientList');
  if (!list) return;

  list.innerHTML = (clients || []).map((client) => `
    <div class="client-row">
      <div>
        <strong>${escapeHTML(client.name)}</strong>
        <div class="alert-details">${escapeHTML(client.industry)} · ${escapeHTML(client.region)}</div>
      </div>
      <div class="client-meta">
        <span class="status-tag ${client.status === 'Trusted' || client.status === 'Verified' ? 'success' : 'warning'}">${escapeHTML(client.status)}</span>
        <span class="risk-tag ${['low', 'medium', 'high'].includes(String(client.risk).toLowerCase()) ? String(client.risk).toLowerCase() : 'unknown'}">${escapeHTML(client.risk)}</span>
      </div>
    </div>
  `).join('');
}

function renderManagement(data) {
  const finance = data.finance || {};
  document.getElementById('cashBalanceInput').value = finance.cashBalance || '';
  document.getElementById('monthlyExpensesInput').value = finance.monthlyExpenses || '';
  document.getElementById('monthlyRevenueInput').value = finance.monthlyRevenue || '';

  const cashBalance = Number(finance.cashBalance) || 0;
  const monthlyExpenses = Number(finance.monthlyExpenses) || 0;
  const monthlyRevenue = Number(finance.monthlyRevenue) || 0;
  const netBurn = monthlyExpenses - monthlyRevenue;
  const hasFinancialInputs = cashBalance > 0 || monthlyExpenses > 0 || monthlyRevenue > 0;
  let summary = '<div class="finance-result muted">Enter your current figures to calculate an estimate.</div>';
  if (hasFinancialInputs) {
    const runway = netBurn > 0
      ? `${(cashBalance / netBurn).toFixed(1)} months`
      : netBurn < 0 ? 'Cash-flow positive' : 'Break-even';
    const monthlyNet = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 }).format(Math.abs(netBurn));
    const flowLabel = netBurn > 0
      ? 'Estimated monthly net burn'
      : netBurn < 0 ? 'Estimated monthly net surplus' : 'Estimated monthly net flow';
    summary = `
      <div class="finance-result">
        <div><span>Estimated runway</span><strong>${escapeHTML(runway)}</strong></div>
        <div><span>${flowLabel}</span><strong>${netBurn > 0 ? '-' : netBurn < 0 ? '+' : ''}${escapeHTML(monthlyNet)}</strong></div>
      </div>
    `;
  }
  document.getElementById('financeSummary').innerHTML = summary;

  document.getElementById('taskList').innerHTML = (data.tasks || []).map((task) => `
    <div class="task-row">
      <div>
        <strong>${escapeHTML(task.title)}</strong>
        <div class="alert-details">
          ${escapeHTML(task.priority)} priority · ${escapeHTML(task.status.replace('_', ' '))}
        </div>
      </div>
      ${canManageWorkspace() ? `<button class="mini-btn" type="button" data-task-id="${escapeHTML(task.id)}" data-task-status="${task.status === 'done' ? 'planned' : task.status === 'planned' ? 'in_progress' : 'done'}">
        ${task.status === 'done' ? 'Reopen' : task.status === 'planned' ? 'Start' : 'Complete'}
      </button>` : ''}
    </div>
  `).join('') || '<p class="muted">No work items yet. Add one to get started.</p>';
}

function appendChatMessage(role, content) {
  const message = document.createElement('div');
  message.className = `chat-message ${role}`;
  const label = document.createElement('strong');
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  const body = document.createElement('p');
  body.textContent = content;
  message.append(label, body);
  document.getElementById('chatMessages').appendChild(message);
  message.scrollIntoView({ block: 'nearest' });
}

async function loadAssistantStatus() {
  const badge = document.getElementById('assistantStatus');
  try {
    const result = await fetchJson('/api/assistant/status');
    badge.textContent = result.configured ? 'AI configured' : 'AI_API_KEY required';
    if (!result.configured) {
      document.getElementById('chatMessages').textContent =
        'Configure AI_API_KEY on the server to enable chat. Your API key is never sent to the browser.';
    }
  } catch (error) {
    badge.textContent = 'Configuration check failed';
    document.getElementById('chatMessages').textContent = error.message;
  }
}

function updateText() {
  const strings = state.strings;
  if (!strings || !Object.keys(strings).length) return;

  setText('appTitle', strings.title);
  setText('appSubtitle', strings.subtitle);
  setText('langLabel', strings.language);
  setText('riskTitle', strings.risk);
  setText('scoreLabel', strings.score);
  setText('summaryLabel', strings.summary);
  setText('systemsHeading', strings.systems);
  setText('alertsHeading', strings.alerts);
  setText('auditHeading', strings.audit);
  setText('complianceHeading', strings.compliance);
  setText('researchBriefHeading', strings.researchBrief);
  setText('verifiedHeading', strings.verified);
  setText('assumptionsHeading', strings.assumptions);
  setText('actionsHeading', strings.actions);
  setText('nextReviewHeading', strings.nextReview);
  setText('loginTitle', strings.loginTitle);
  setText('welcomeText', strings.welcome);
  setText('emailLabel', strings.email);
  setText('passwordLabel', strings.password);
  setText('loginButton', strings.signIn);
  setText('securityNote', strings.securityNote);
  setText('locationRiskTitle', strings.locationRisk);
  setText('systemHealthTitle', strings.systemHealth);
  setText('fileManagerHeading', strings.fileManagement || 'CSV & file management');
  setText('clientManagerHeading', strings.clientManagement || 'Client management');

  const navMap = {
    overview: strings.overview,
    defense: strings.defense,
    business: strings.business,
    research: strings.research,
    models: strings.models,
    files: strings.files,
    clients: strings.clients,
    management: strings.startupManagement,
    assistant: strings.assistant
  };

  Object.entries(navMap).forEach(([key, label]) => {
    const el = document.querySelector(`.nav-tab[data-tab="${key}"]`);
    if (el && label) el.textContent = label;
  });
}

function bindTabs() {
  document.querySelectorAll('.nav-tab').forEach((button) => {
    button.addEventListener('click', () => {
      document.querySelectorAll('.nav-tab').forEach((btn) => btn.classList.toggle('active', btn === button));
      Object.entries(tabMap).forEach(([key, panel]) => {
        panel.classList.toggle('active', key === button.dataset.tab);
      });
    });
  });
}

function bindLanguage() {
  const select = document.getElementById('languageSelect');
  select.addEventListener('change', async (event) => {
    await setLocale(event.target.value);
  });
}

function bindAuthMode() {
  document.querySelectorAll('.auth-mode-btn').forEach((button) => {
    button.addEventListener('click', () => {
      setAuthMode(button.dataset.mode);
    });
  });
}

async function setLocale(locale) {
  const payload = await fetchJson(`/api/locales/${locale}`);
  state.locale = locale;
  state.strings = payload.strings;
  updateText();
  document.documentElement.lang = locale;
}

async function loadDashboard() {
  const data = await fetchJson('/api/dashboard/all');
  state.dashboard = data;
  renderOverview(data);
  renderDefense(data);
  renderBusiness(data);
  renderResearch(data);
  renderModels(data);
  renderFileVault(data.files || []);
  renderClientList(data.clients || []);
  renderLoginInfo({ locations: data.locationRisk || [], controls: data.securityControls || [] });
  const management = await fetchJson('/api/management');
  renderManagement(management);
  state.chatMessages = [];
  document.getElementById('chatMessages').replaceChildren();
  await loadAssistantStatus();
  showDashboard(true);
}

async function initSession() {
  const isWorkspaceRoute = window.location.pathname.replace(/\/+$/, '') === '/workspace';
  if (!isWorkspaceRoute) {
    showDashboard(false);
    return;
  }

  try {
    const authConfig = await fetchJson('/api/auth/config');
    const registrationButton = document.querySelector('.auth-mode-btn[data-mode="register"]');
    if (registrationButton) registrationButton.classList.toggle('hidden', !authConfig.registrationEnabled);
    if (!authConfig.registrationEnabled && state.authMode === 'register') setAuthMode('login');
  } catch {
    setAuthMode('login');
  }

  try {
    const result = await fetchJson('/api/auth/me');
    if (result.user) {
      state.isAuthenticated = true;
      setWorkspaceRole(result.user.role);
      await loadDashboard();
      return;
    }
  } catch {
    // ignore
  }

  state.isAuthenticated = false;
  setWorkspaceRole('viewer');
  showDashboard(false);
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const email = document.getElementById('emailInput').value.trim();
  const password = document.getElementById('passwordInput').value;
  const name = document.getElementById('nameInput').value.trim();
  const errorMessage = document.getElementById('authError');
  const submitButton = document.getElementById('loginButton');
  errorMessage.textContent = '';
  errorMessage.classList.add('hidden');
  submitButton.disabled = true;
  submitButton.textContent = state.authMode === 'register' ? 'Creating account…' : 'Signing in…';

  try {
    const endpoint = state.authMode === 'register' ? '/api/auth/register' : '/api/auth/login';
    const payload = state.authMode === 'register'
      ? { name, email, password }
      : { email, password };

    const result = await fetchJson(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    state.isAuthenticated = true;
    setWorkspaceRole(result.user?.role);
    await loadDashboard();
  } catch (error) {
    errorMessage.textContent = error.message || 'Authentication failed';
    errorMessage.classList.remove('hidden');
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = state.authMode === 'register' ? 'Create account' : 'Sign in';
  }
}

async function handleFileUpload(event) {
  event.preventDefault();
  const input = document.getElementById('csvInput');
  if (!input.files || !input.files[0]) {
    alert('Please choose a CSV file first');
    return;
  }

  const formData = new FormData();
  formData.append('file', input.files[0]);

  try {
    await fetchJson('/api/files/upload', {
      method: 'POST',
      body: formData
    });

    input.value = '';
    const data = await fetchJson('/api/dashboard/all');
    renderFileVault(data.files || []);
  } catch (error) {
    alert(error.message || 'CSV upload failed');
  }
}

async function handleClientSubmit(event) {
  event.preventDefault();
  const payload = {
    name: document.getElementById('clientNameInput').value.trim(),
    industry: document.getElementById('clientIndustryInput').value.trim(),
    owner: document.getElementById('clientOwnerInput').value.trim(),
    region: document.getElementById('clientRegionInput').value.trim()
  };

  if (!payload.name || !payload.industry) {
    alert('Client name and industry are required');
    return;
  }

  try {
    await fetchJson('/api/clients', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    document.getElementById('clientForm').reset();
    const data = await fetchJson('/api/dashboard/all');
    renderClientList(data.clients || []);
  } catch (error) {
    alert(error.message || 'Client save failed');
  }
}

async function handleFinanceSubmit(event) {
  event.preventDefault();
  const payload = {
    cashBalance: Number(document.getElementById('cashBalanceInput').value),
    monthlyExpenses: Number(document.getElementById('monthlyExpensesInput').value),
    monthlyRevenue: Number(document.getElementById('monthlyRevenueInput').value)
  };
  try {
    await fetchJson('/api/management/finance', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await fetchJson('/api/management');
    renderManagement(data);
  } catch (error) {
    alert(error.message || 'Financial inputs could not be saved');
  }
}

async function handleTaskSubmit(event) {
  event.preventDefault();
  const title = document.getElementById('taskTitleInput').value.trim();
  const priority = document.getElementById('taskPriorityInput').value;
  try {
    await fetchJson('/api/management/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, priority })
    });
    document.getElementById('taskForm').reset();
    const data = await fetchJson('/api/management');
    renderManagement(data);
  } catch (error) {
    alert(error.message || 'Work item could not be added');
  }
}

async function updateTaskStatus(taskId, status) {
  try {
    await fetchJson(`/api/management/tasks/${encodeURIComponent(taskId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status })
    });
    const data = await fetchJson('/api/management');
    renderManagement(data);
  } catch (error) {
    alert(error.message || 'Work item could not be updated');
  }
}

async function handleChatSubmit(event) {
  event.preventDefault();
  const input = document.getElementById('chatInput');
  const button = document.getElementById('chatSubmitButton');
  const content = input.value.trim();
  if (!content) return;

  state.chatMessages.push({ role: 'user', content });
  state.chatMessages = state.chatMessages.slice(-20);
  appendChatMessage('user', content);
  input.value = '';
  button.disabled = true;
  try {
    const result = await fetchJson('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: state.chatMessages })
    });
    state.chatMessages.push({ role: 'assistant', content: result.reply });
    state.chatMessages = state.chatMessages.slice(-20);
    appendChatMessage('assistant', result.reply);
    document.getElementById('assistantStatus').textContent = 'AI responding';
  } catch (error) {
    appendChatMessage('assistant', error.message || 'The assistant could not complete the request.');
  } finally {
    button.disabled = false;
    input.focus();
  }
}

async function toggleFileProtection(fileId) {
  try {
    await fetchJson(`/api/files/${fileId}/secure`, { method: 'POST' });
    const data = await fetchJson('/api/dashboard/all');
    renderFileVault(data.files || []);
  } catch (error) {
    alert(error.message || 'File update failed');
  }
}

function bindActions() {
  document.getElementById('authForm').addEventListener('submit', handleAuthSubmit);
  document.getElementById('fileUploadForm').addEventListener('submit', handleFileUpload);
  document.getElementById('clientForm').addEventListener('submit', handleClientSubmit);
  document.getElementById('financeForm').addEventListener('submit', handleFinanceSubmit);
  document.getElementById('taskForm').addEventListener('submit', handleTaskSubmit);
  document.getElementById('chatForm').addEventListener('submit', handleChatSubmit);

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetchJson('/api/auth/logout', { method: 'POST' });
    state.isAuthenticated = false;
    window.location.assign('/');
  });

  document.getElementById('fileVaultList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-file-id]');
    if (button) {
      toggleFileProtection(button.dataset.fileId);
    }
  });

  document.getElementById('taskList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-task-id]');
    if (button) {
      updateTaskStatus(button.dataset.taskId, button.dataset.taskStatus);
    }
  });
}

async function init() {
  initLandingGraphs();
  bindPublicCheckup();
  bindTabs();
  bindLanguage();
  bindAuthMode();
  bindActions();
  await setLocale('en');
  await initSession();
}

init();
