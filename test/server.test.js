const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const originalDataDir = process.env.DATA_DIR;
const originalSessionSecret = process.env.SESSION_SECRET;
const originalNodeEnv = process.env.NODE_ENV;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-business-shield-test-'));
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = 'test-only-session-secret';
process.env.NODE_ENV = 'test';

const { app, loadJson, saveJson, readCsvPreview, toCsv } = require('../server');
if (originalDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = originalDataDir;
if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
else process.env.SESSION_SECRET = originalSessionSecret;
if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
else process.env.NODE_ENV = originalNodeEnv;

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
  fs.rmSync(testDataDir, { recursive: true, force: true });
});

async function login(email, password) {
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  assert.equal(response.status, 200);
  return response.headers.get('set-cookie').split(';', 1)[0];
}

test('preserves corrupt JSON files and saves updates atomically', () => {
  const directory = fs.mkdtempSync(path.join(testDataDir, 'storage-test-'));
  const corruptFile = path.join(directory, 'corrupt.json');
  fs.writeFileSync(corruptFile, '{"unfinished":');
  assert.throws(() => loadJson(corruptFile, {}), /existing file was left unchanged/);
  assert.equal(fs.readFileSync(corruptFile, 'utf8'), '{"unfinished":');
  const emptyFile = path.join(directory, 'empty.json');
  fs.writeFileSync(emptyFile, '');
  assert.throws(() => loadJson(emptyFile, {}), /existing file was left unchanged/);
  assert.equal(fs.readFileSync(emptyFile, 'utf8'), '');

  const validFile = path.join(directory, 'valid.json');
  saveJson(validFile, { version: 1 });
  saveJson(validFile, { version: 2 });
  assert.deepEqual(JSON.parse(fs.readFileSync(validFile, 'utf8')), { version: 2 });

  const blockedTarget = path.join(directory, 'blocked.json');
  fs.mkdirSync(blockedTarget);
  fs.writeFileSync(path.join(blockedTarget, 'preserve.txt'), 'keep');
  assert.throws(() => saveJson(blockedTarget, { version: 3 }));
  assert.equal(fs.readFileSync(path.join(blockedTarget, 'preserve.txt'), 'utf8'), 'keep');
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('.blocked.json.')), false);
});

test('parses quoted CSV previews, embedded newlines and escaped quotes', () => {
  const csvFile = path.join(testDataDir, 'quoted-preview.csv');
  fs.writeFileSync(
    csvFile,
    'name,city,note\r\n"Ada, Inc.",London,"Line one\r\nLine two"\r\n"Quoted","Tokyo","She said ""hello"""',
    'utf8'
  );
  assert.deepEqual(readCsvPreview(csvFile, 8), [
    ['name', 'city', 'note'],
    ['Ada, Inc.', 'London', 'Line one\r\nLine two'],
    ['Quoted', 'Tokyo', 'She said "hello"']
  ]);
  assert.equal(readCsvPreview(csvFile, 2).length, 2);
});

test('neutralizes spreadsheet formulas while retaining valid CSV quoting', () => {
  const csv = toCsv([
    { value: '=HYPERLINK("https://example.test","open")' },
    { value: '\t@SUM(1,2)' },
    { value: '+1+1' },
    { value: '-1+1' },
    { value: 'Ordinary, Inc.' }
  ]);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/example\.test"",""open""\)"/);
  assert.match(csv, /"'\t@SUM\(1,2\)"/);
  assert.match(csv, /^'\+1\+1$/m);
  assert.match(csv, /^'-1\+1$/m);
  assert.match(csv, /"Ordinary, Inc\."/);
});

test('viewers can read workspace data but cannot change shared records', async () => {
  const viewerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Read Only User', email: 'viewer@example.test', password: 'viewer-test-password' })
  });
  assert.equal(viewerResponse.status, 201);
  const viewerCookie = viewerResponse.headers.get('set-cookie').split(';', 1)[0];

  const before = await Promise.all(['/api/management', '/api/files', '/api/clients'].map(async (route) => {
    const response = await fetch(`${baseUrl}${route}`, { headers: { Cookie: await login('admin@northstar.com', 'Shield@2026!') } });
    assert.equal(response.status, 200);
    return response.json();
  }));
  const readResponse = await fetch(`${baseUrl}/api/management`, { headers: { Cookie: viewerCookie } });
  assert.equal(readResponse.status, 200);

  const attempts = [
    ['/api/management/finance', 'PUT', { cashBalance: 9999, monthlyExpenses: 1, monthlyRevenue: 1 }],
    ['/api/management/tasks', 'POST', { title: 'Unauthorized task', priority: 'high' }],
    ['/api/management/tasks/missing-task', 'PATCH', { status: 'done' }],
    ['/api/files/upload', 'POST', undefined],
    ['/api/files/file-101/secure', 'POST', undefined],
    ['/api/clients', 'POST', { name: 'Unauthorized', industry: 'Test' }]
  ];
  for (const [route, method, body] of attempts) {
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      headers: { Cookie: viewerCookie, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    assert.equal(response.status, 403, `${method} ${route} should be denied to a viewer`);
  }

  const adminCookie = await login('admin@northstar.com', 'Shield@2026!');
  const after = await Promise.all(['/api/management', '/api/files', '/api/clients'].map(async (route) => {
    const response = await fetch(`${baseUrl}${route}`, { headers: { Cookie: adminCookie } });
    return response.json();
  }));
  assert.deepEqual(after, before);
});

test('operations accounts retain permission to manage shared workspace data', async () => {
  const cookie = await login('ops@northstar.com', 'Ops@2026!');
  const response = await fetch(`${baseUrl}/api/management/tasks`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'Authorized operations task', priority: 'medium' })
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).task.title, 'Authorized operations task');
});

test('admins can upload valid CSVs and export client values as inert cells', async () => {
  const cookie = await login('admin@northstar.com', 'Shield@2026!');
  const maliciousValue = '=HYPERLINK("https://example.test","open")';
  const clientResponse = await fetch(`${baseUrl}/api/clients`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: maliciousValue, industry: 'Testing' })
  });
  assert.equal(clientResponse.status, 200);

  const exportResponse = await fetch(`${baseUrl}/api/exports/clients.csv`, { headers: { Cookie: cookie } });
  assert.equal(exportResponse.status, 200);
  assert.match(await exportResponse.text(), /"'=HYPERLINK\(""https:\/\/example\.test"",""open""\)"/);

  const form = new FormData();
  form.append(
    'file',
    new Blob(['name,city,note\r\n"Ada, Inc.",London,"She said ""hello"""'], { type: 'text/csv' }),
    'quoted-clients.csv'
  );
  const uploadResponse = await fetch(`${baseUrl}/api/files/upload`, { method: 'POST', headers: { Cookie: cookie }, body: form });
  assert.equal(uploadResponse.status, 200);
  const uploadResult = await uploadResponse.json();
  assert.deepEqual(uploadResult.file.preview, [
    ['name', 'city', 'note'],
    ['Ada, Inc.', 'London', 'She said "hello"']
  ]);

  const malformedForm = new FormData();
  malformedForm.append('file', new Blob(['name,city\n"Unclosed,London'], { type: 'text/csv' }), 'broken.csv');
  const malformedResponse = await fetch(`${baseUrl}/api/files/upload`, { method: 'POST', headers: { Cookie: cookie }, body: malformedForm });
  assert.equal(malformedResponse.status, 400);
  const filesResponse = await fetch(`${baseUrl}/api/files`, { headers: { Cookie: cookie } });
  const filesResult = await filesResponse.json();
  assert.equal(filesResult.files.some((file) => file.name === 'broken.csv'), false);
});
