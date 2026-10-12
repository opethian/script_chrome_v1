const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const A = require('../extension/shared.js');

test('album photo IDs become exact main-view URLs in the same account', () => {
  const route = A.route('https://photos.google.com/u/2/album/album-1/photo/photo-2?foo=bar');
  assert.equal(route.kind, 'album-photo');
  assert.equal(route.albumId, 'album-1');
  assert.equal(route.photoId, 'photo-2');
  assert.equal(route.photoUrl, 'https://photos.google.com/u/2/photo/photo-2');
  assert.equal(route.albumUrl, 'https://photos.google.com/u/2/album/album-1');
});
test('unrelated origins, shared links, and extra route components are rejected', () => {
  for (const url of ['http://photos.google.com/album/a', 'https://photos.google.com.evil.test/album/a', 'https://evil.test/photo/a', 'https://photos.google.com/share/a', 'https://photos.google.com/photo/a/extra', 'garbage']) {
    assert.equal(A.route(url), null, url);
  }
});
test('localized archive labels are exact and cannot select delete or unarchive', () => {
  for (const label of ['Archive', 'Arşivle', 'Arkivera', 'Archivieren', 'Archiver']) assert.equal(A.matches('archive', label), true);
  for (const label of ['Unarchive', 'Remove from archive', 'Delete', 'Move to trash', 'Archive and delete']) assert.equal(A.matches('archive', label), false);
  assert.equal(A.matches('unarchive', 'Arşivden çıkar'), true);
});
test('in-flight operations are counted as uncertain, never archived', () => {
  assert.deepEqual(A.counts({ photos: [{ status: 'archived' }, { status: 'already-archived' }, { status: 'pending' }, { status: 'processing' }, { status: 'uncertain' }] }), { total: 5, archived: 1, alreadyArchived: 1, pending: 1, uncertain: 2 });
});
test('manifest assets exist and privileges are limited to the Photos workflow', () => {
  const root = path.join(__dirname, '../extension');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.host_permissions, ['https://photos.google.com/*']);
  assert.deepEqual(manifest.permissions, ['storage', 'tabs', 'debugger']);
  for (const name of [manifest.action.default_popup, manifest.background.service_worker, ...manifest.content_scripts.flatMap(entry => entry.js), ...Object.values(manifest.icons)]) assert.equal(fs.existsSync(path.join(root, name)), true, name);
});
