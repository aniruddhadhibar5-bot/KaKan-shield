const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');

const originalDataDir = process.env.DATA_DIR;
const originalSessionSecret = process.env.SESSION_SECRET;
const originalDataEncryptionKey = process.env.DATA_ENCRYPTION_KEY;
const originalNodeEnv = process.env.NODE_ENV;
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-business-shield-test-'));
process.env.DATA_DIR = testDataDir;
process.env.SESSION_SECRET = 'test-only-session-secret';
process.env.DATA_ENCRYPTION_KEY = 'test-only-data-encryption-key-with-at-least-32-bytes';
process.env.NODE_ENV = 'test';

const {
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
} = require('../server');
if (originalDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = originalDataDir;
if (originalSessionSecret === undefined) delete process.env.SESSION_SECRET;
else process.env.SESSION_SECRET = originalSessionSecret;
if (originalDataEncryptionKey === undefined) delete process.env.DATA_ENCRYPTION_KEY;
else process.env.DATA_ENCRYPTION_KEY = originalDataEncryptionKey;
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
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
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
  assert.equal(isEncryptedData(fs.readFileSync(validFile)), true);
  saveJson(validFile, { version: 2 });
  assert.deepEqual(loadJson(validFile, {}), { version: 2 });

  const legacyFile = path.join(directory, 'legacy.json');
  fs.writeFileSync(legacyFile, '{"legacy":true}');
  assert.deepEqual(loadJson(legacyFile, {}), { legacy: true });
  assert.equal(isEncryptedData(fs.readFileSync(legacyFile)), true);
  assert.deepEqual(JSON.parse(decryptData(fs.readFileSync(legacyFile)).toString('utf8')), { legacy: true });

  const blockedTarget = path.join(directory, 'blocked.json');
  fs.mkdirSync(blockedTarget);
  fs.writeFileSync(path.join(blockedTarget, 'preserve.txt'), 'keep');
  assert.throws(() => saveJson(blockedTarget, { version: 3 }));
  assert.equal(fs.readFileSync(path.join(blockedTarget, 'preserve.txt'), 'utf8'), 'keep');
  assert.equal(fs.readdirSync(directory).some((name) => name.startsWith('.blocked.json.')), false);
});

test('encrypts legacy uploaded CSVs and rejects tampered ciphertext', () => {
  const uploadPath = path.join(testDataDir, 'uploads', 'legacy-upload.csv');
  const original = Buffer.from('name,email\nExample,person@example.test\n');
  fs.writeFileSync(uploadPath, original);
  const metadata = [{ storedName: path.basename(uploadPath), status: 'Protected' }];
  migrateUploadedFiles(metadata);
  const encrypted = fs.readFileSync(uploadPath);
  assert.equal(isEncryptedData(encrypted), true);
  assert.deepEqual(decryptData(encrypted), original);
  assert.equal(metadata[0].status, 'Encrypted');

  const tampered = Buffer.from(encryptData(original));
  tampered[tampered.length - 1] ^= 0xff;
  assert.throws(() => decryptData(tampered));
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

test('production registration is disabled and admins can provision team accounts', async () => {
  assert.equal(isPublicRegistrationAllowed('production'), false);
  assert.equal(isPublicRegistrationAllowed('development'), true);

  const originalEnvironment = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const registrationResponse = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Uninvited User',
        email: 'uninvited@example.test',
        password: 'a-long-unique-password'
      })
    });
    assert.equal(registrationResponse.status, 403);
  } finally {
    process.env.NODE_ENV = originalEnvironment;
  }

  const adminCookie = await login('admin@northstar.com', 'Shield@2026!');
  const response = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Team Analyst',
      email: 'team.analyst@example.test',
      password: 'a-long-unique-team-password',
      role: 'analyst'
    })
  });
  assert.equal(response.status, 201);
  const result = await response.json();
  assert.equal(result.user.role, 'analyst');
  assert.equal(JSON.stringify(result).includes('a-long-unique-team-password'), false);

  const duplicateResponse = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: { Cookie: adminCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Duplicate User',
      email: 'team.analyst@example.test',
      password: 'another-long-unique-password',
      role: 'viewer'
    })
  });
  assert.equal(duplicateResponse.status, 409);

  const viewerCookie = await login('viewer@example.test', 'viewer-test-password');
  const deniedResponse = await fetch(`${baseUrl}/api/admin/users`, {
    method: 'POST',
    headers: { Cookie: viewerCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Unauthorized User',
      email: 'unauthorized@example.test',
      password: 'another-long-unique-password',
      role: 'viewer'
    })
  });
  assert.equal(deniedResponse.status, 403);
});

test('new accounts require long passwords and valid email addresses', async () => {
  for (const body of [
    { name: 'Short Password', email: 'valid@example.test', password: 'short' },
    { name: 'Invalid Email', email: 'not-an-email', password: 'a-long-unique-password' }
  ]) {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }
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
  assert.equal(uploadResult.file.status, 'Encrypted');
  assert.deepEqual(uploadResult.file.preview, [
    ['name', 'city', 'note'],
    ['Ada, Inc.', 'London', 'She said "hello"']
  ]);
  const uploadedPath = path.join(testDataDir, 'uploads', uploadResult.file.storedName);
  const storedUpload = fs.readFileSync(uploadedPath);
  assert.equal(isEncryptedData(storedUpload), true);
  assert.equal(storedUpload.includes(Buffer.from('Ada, Inc.')), false);
  const downloadResponse = await fetch(`${baseUrl}/api/files/${uploadResult.file.id}/download`, {
    headers: { Cookie: cookie }
  });
  assert.equal(downloadResponse.status, 200);
  assert.equal(await downloadResponse.text(), 'name,city,note\r\n"Ada, Inc.",London,"She said ""hello"""');

  const malformedForm = new FormData();
  malformedForm.append('file', new Blob(['name,city\n"Unclosed,London'], { type: 'text/csv' }), 'broken.csv');
  const malformedResponse = await fetch(`${baseUrl}/api/files/upload`, { method: 'POST', headers: { Cookie: cookie }, body: malformedForm });
  assert.equal(malformedResponse.status, 400);
  const filesResponse = await fetch(`${baseUrl}/api/files`, { headers: { Cookie: cookie } });
  const filesResult = await filesResponse.json();
  assert.equal(filesResult.files.some((file) => file.name === 'broken.csv'), false);
});
