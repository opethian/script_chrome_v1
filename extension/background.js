'use strict';
importScripts('shared.js');
const A = globalThis.AlbumArchiver;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const MAX_PHOTOS = 5000;
let active = null;

async function readJob() {
  return (await chrome.storage.local.get(A.jobKey))[A.jobKey] || null;
}
async function save(job) {
  job.updatedAt = Date.now();
  await chrome.storage.local.set({ [A.jobKey]: job });
}
const boot = (async () => {
  const job = await readJob();
  if (job && ['scanning', 'archiving'].includes(job.phase)) {
    for (const photo of job.photos) if (photo.status === 'processing') photo.status = 'uncertain';
    job.phase = 'interrupted';
    job.message = 'The extension restarted. No actions were resumed automatically.';
    job.error = job.scanComplete ? 'Check any uncertain photo in Google Photos Archive before scanning again.' : 'The album scan was interrupted. Scan the album again.';
    await save(job);
  }
})();

function checkpoint(operation) {
  if (operation.stop) throw new Error('Stopped by you.');
}
async function page(tabId, type, extra = {}) {
  const reply = await chrome.tabs.sendMessage(tabId, { type, ...extra });
  if (!reply?.ok) {
    const error = new Error(reply?.error || 'The Photos page did not respond. Reload that tab and try again.');
    error.fromPage = true;
    throw error;
  }
  return reply;
}
async function waitSnapshot(tabId, predicate, timeout = 7000) {
  const deadline = Date.now() + timeout;
  let lastError = null;
  while (Date.now() < deadline) {
    let value;
    try {
      value = await page(tabId, 'AA_PAGE_SNAPSHOT');
    } catch (error) { lastError = error; }
    if (value && predicate(value)) return value;
    await sleep(100);
  }
  throw new Error(lastError?.message || 'Google Photos did not finish loading the expected photo.');
}
async function attach(operation, tabId) {
  await chrome.debugger.attach({ tabId }, '1.3');
  operation.debuggerTabId = tabId;
  operation.debuggerAttached = true;
}
async function detach(operation) {
  if (!operation.debuggerAttached) return;
  operation.debuggerAttached = false;
  try { await chrome.debugger.detach({ tabId: operation.debuggerTabId }); } catch { /* The user may have detached it already. */ }
}
async function arrow(operation, direction) {
  checkpoint(operation);
  const right = direction === 'next';
  const key = right ? 'ArrowRight' : 'ArrowLeft';
  const code = right ? 39 : 37;
  const target = { tabId: operation.sourceTabId };
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code });
  await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
}
function ensureAlbum(snapshot, job) {
  const current = snapshot.route;
  if (current?.kind !== 'album-photo' || current.albumId !== job.albumId || current.account !== job.account) {
    throw new Error('The tab left the selected album or account. Scanning stopped.');
  }
}
async function move(operation, job, current, direction) {
  checkpoint(operation);
  ensureAlbum(current, job);
  if (current[direction] === 'end') return null;
  if (current[direction] !== 'ready') throw new Error('The Photos navigation controls were not recognized. Check the interface language and reload the album.');
  await arrow(operation, direction);
  const next = await waitSnapshot(operation.sourceTabId, value => {
    checkpoint(operation);
    ensureAlbum(value, job);
    return value.route.photoId !== current.route.photoId;
  });
  await sleep(250);
  const settled = await page(operation.sourceTabId, 'AA_PAGE_SNAPSHOT');
  ensureAlbum(settled, job);
  if (settled.route.photoId !== next.route.photoId) throw new Error('The album moved again unexpectedly. Scanning stopped.');
  return settled;
}
async function scan(operation, job) {
  try {
    let current;
    try { current = await page(operation.sourceTabId, 'AA_PAGE_OPEN_ALBUM'); }
    catch (error) {
      if (error.fromPage) throw error;
      // Clicking a thumbnail may replace the document and close its message
      // channel. Wait for the new viewer rather than reissuing the click.
      current = await waitSnapshot(operation.sourceTabId, value => value.route?.kind === 'album-photo' && value.route.albumId === job.albumId && value.route.account === job.account);
    }
    ensureAlbum(current, job);
    await attach(operation, operation.sourceTabId);
    const rewound = new Set();
    while (current.previous !== 'end') {
      checkpoint(operation);
      if (rewound.has(current.route.photoId) || rewound.size >= MAX_PHOTOS) throw new Error('Could not locate the start of the album. Scanning stopped.');
      rewound.add(current.route.photoId);
      job.message = 'Finding the first photo in the album…';
      await save(job);
      current = await move(operation, job, current, 'previous');
    }
    const seen = new Set();
    while (current) {
      checkpoint(operation);
      ensureAlbum(current, job);
      const id = current.route.photoId;
      if (seen.has(id)) throw new Error('A photo repeated before a confirmed album end. The scan is incomplete.');
      if (seen.size >= MAX_PHOTOS) throw new Error(`This version supports up to ${MAX_PHOTOS} photos per album.`);
      seen.add(id);
      job.photos.push({ id, url: current.route.photoUrl, status: 'pending' });
      job.message = `Scanned ${job.photos.length} photo${job.photos.length === 1 ? '' : 's'}.`;
      await save(job);
      current = await move(operation, job, current, 'next');
    }
    checkpoint(operation);
    job.scanComplete = true;
    job.phase = 'ready';
    job.message = `Ready to archive ${job.photos.length} album photo${job.photos.length === 1 ? '' : 's'}.`;
    await save(job);
  } catch (error) {
    job.phase = operation.stop ? 'stopped' : 'error';
    job.message = operation.stop ? 'Scan stopped. Scan again before archiving.' : 'Album scan incomplete. No photos were archived.';
    job.error = error.message;
    await save(job);
  } finally {
    await detach(operation);
    if (active === operation) active = null;
  }
}

async function loadPhoto(tabId, photo, job, reload = false) {
  if (reload) await chrome.tabs.reload(tabId);
  else await chrome.tabs.update(tabId, { url: photo.url });
  return waitSnapshot(tabId, value => {
    const route = value.route;
    return route?.kind === 'photo' && route.photoId === photo.id && route.account === job.account;
  });
}
async function verify(tabId, photo, job) {
  // A native Archive action can close the viewer. Reopen the same photo ID;
  // never infer success from a click, disappearing viewer, or notification.
  await sleep(600);
  await loadPhoto(tabId, photo, job);
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await page(tabId, 'AA_PAGE_ARCHIVE_STATE', { photoId: photo.id, account: job.account });
    if (result.state === 'archived') return;
    if (attempt < 2) {
      await sleep(700);
      await loadPhoto(tabId, photo, job, true);
    }
  }
  throw new Error('Google Photos still offers Archive for this photo. The result is uncertain; check it manually before retrying.');
}
async function archive(operation, job) {
  let current = null;
  try {
    checkpoint(operation);
    const helper = await chrome.tabs.create({ url: 'about:blank', active: true });
    operation.workingTabId = helper.id;
    job.workingTabId = helper.id;
    await attach(operation, helper.id); // Active debugger sessions keep MV3 workers alive.
    await save(job);
    for (const photo of job.photos) {
      if (photo.status !== 'pending') continue;
      checkpoint(operation);
      current = photo;
      await loadPhoto(helper.id, photo, job);
      checkpoint(operation);
      photo.status = 'processing';
      job.message = `Checking photo ${job.photos.indexOf(photo) + 1} of ${job.photos.length}…`;
      await save(job);
      let result;
      let communicationError = null;
      try {
        // Do not retry this command if navigation closes its message channel.
        result = await chrome.tabs.sendMessage(helper.id, { type: 'AA_PAGE_ARCHIVE', photoId: photo.id, account: job.account });
      } catch (error) { communicationError = error; }
      if (result && !result.ok) {
        photo.status = 'pending';
        throw new Error(result.error || 'No archive action was sent.');
      }
      if (result?.alreadyArchived) {
        photo.status = 'already-archived';
      } else if (result?.attempted || communicationError || !result) {
        await verify(helper.id, photo, job);
        photo.status = 'archived';
      } else {
        throw new Error('The archive response could not be verified.');
      }
      current = null;
      job.message = `Verified ${A.counts(job).archived + A.counts(job).alreadyArchived} of ${job.photos.length} photos.`;
      await save(job);
    }
    job.phase = operation.stop ? 'stopped' : 'done';
    job.message = operation.stop ? 'Stopped before the next photo. You can resume the pending photos.' : 'All scanned photos have a verified archived state.';
    await save(job);
  } catch (error) {
    if (current?.status === 'processing') current.status = 'uncertain';
    job.phase = operation.stop ? 'stopped' : 'error';
    job.message = operation.stop ? 'Stopped. Review any uncertain result before continuing.' : 'Archiving stopped at the first unresolved photo.';
    job.error = error.message;
    await save(job);
  } finally {
    await detach(operation);
    if (active === operation) active = null;
  }
}

async function startScan(tabId) {
  if (active) throw new Error('An operation is already running. Stop it first.');
  const operation = { sourceTabId: tabId, stop: false };
  active = operation;
  try {
    const tab = await chrome.tabs.get(tabId);
    const route = A.route(tab.url);
    if (!route || !['album', 'album-photo'].includes(route.kind)) throw new Error('Open your Google Photos album, then open one photo in it.');
    const job = { id: crypto.randomUUID(), sourceTabId: tabId, account: route.account, albumId: route.albumId, albumUrl: route.albumUrl, photos: [], phase: 'scanning', scanComplete: false, message: 'Opening the album photo viewer…', error: null, startedAt: Date.now() };
    await save(job);
    void scan(operation, job).catch(error => console.error('Album scan:', error));
    return { job };
  } catch (error) { if (active === operation) active = null; throw error; }
}
async function startArchive(jobId) {
  if (active) throw new Error('An operation is already running. Stop it first.');
  const operation = { stop: false };
  active = operation;
  try {
    const job = await readJob();
    if (!job || job.id !== jobId) throw new Error('The scanned album changed. Review it and try again.');
    if (!job.scanComplete || !job.photos.length) throw new Error('Complete an album scan first.');
    if (A.counts(job).uncertain) throw new Error('Check the uncertain photo in Google Photos Archive, then scan the album again.');
    if (!A.counts(job).pending) throw new Error('There are no pending photos to archive.');
    const source = await chrome.tabs.get(job.sourceTabId);
    const route = A.route(source.url);
    if (!route || route.albumId !== job.albumId || route.account !== job.account) throw new Error('Keep the scanned album tab open in the same account before starting.');
    operation.sourceTabId = job.sourceTabId;
    job.phase = 'archiving';
    job.error = null;
    job.message = 'Opening a working tab. Keep this tab open until the operation finishes.';
    await save(job);
    void archive(operation, job).catch(error => console.error('Album archive:', error));
    return { job };
  } catch (error) { if (active === operation) active = null; throw error; }
}
async function stop() {
  if (!active) return { stopped: false };
  active.stop = true;
  const tabId = active.workingTabId || active.sourceTabId;
  if (tabId) {
    try { await chrome.tabs.sendMessage(tabId, { type: 'AA_PAGE_CANCEL' }); } catch { /* A navigation may already be in progress. */ }
  }
  return { stopped: true };
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!['AA_GET_JOB', 'AA_SCAN', 'AA_ARCHIVE', 'AA_STOP'].includes(message?.type)) return;
  if (sender.id !== chrome.runtime.id || sender.tab) { reply({ ok: false, error: 'Use the extension popup to control album archiving.' }); return; }
  (async () => {
    await boot;
    switch (message.type) {
      case 'AA_GET_JOB': return { job: await readJob(), running: Boolean(active) };
      case 'AA_SCAN': return startScan(message.tabId);
      case 'AA_ARCHIVE': return startArchive(message.jobId);
      case 'AA_STOP': return stop();
    }
  })().then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.debugger.onDetach.addListener(source => {
  if (active?.debuggerAttached && active.debuggerTabId === source.tabId) active.stop = true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  if (active && (active.sourceTabId === tabId || active.workingTabId === tabId)) active.stop = true;
});
