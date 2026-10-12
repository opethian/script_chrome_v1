'use strict';
const A = globalThis.AlbumArchiver;
const $ = id => document.getElementById(id);
let job = null;
let running = false;
let requestPending = false;
let refreshing = false;

function showError(message) {
  $('error').hidden = !message;
  $('error').textContent = message || '';
}
async function send(type, extra = {}) {
  const result = await chrome.runtime.sendMessage({ type, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'The extension did not respond. Reopen the popup.');
  return result;
}
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    const state = await send('AA_GET_JOB');
    job = state.job;
    running = state.running;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const route = A.route(tab?.url);
    const inAlbum = route && ['album', 'album-photo'].includes(route.kind);
    const count = A.counts(job);
    $('total').textContent = count.total;
    $('verified').textContent = count.archived;
    $('already').textContent = count.alreadyArchived;
    $('pending').textContent = count.pending;
    $('uncertain').textContent = count.uncertain;
    $('status').textContent = job?.message || (inAlbum ? 'Album tab ready. Click Scan album.' : 'Open an album and one of its photos in Google Photos.');
    $('scan').disabled = running || requestPending || !inAlbum;
    $('archive').disabled = running || requestPending || !job?.scanComplete || !count.pending || Boolean(count.uncertain);
    $('archive').textContent = count.pending ? `Archive ${count.pending} scanned photo${count.pending === 1 ? '' : 's'}` : 'Archive scanned photos';
    $('stop').disabled = !running || requestPending;
    $('export').disabled = !job;
    if (job?.error) showError(job.error);
  } catch (error) { showError(error.message); }
  finally { refreshing = false; }
}
async function action(callback) {
  if (requestPending) return;
  requestPending = true;
  showError(null);
  for (const id of ['scan', 'archive', 'stop']) $(id).disabled = true;
  try { await callback(); }
  catch (error) { showError(error.message); }
  finally { requestPending = false; await refresh(); }
}
$('scan').addEventListener('click', () => action(async () => {
  if (job?.photos?.length && !confirm('Replace the previous scan and its progress report with a new album scan?')) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active Google Photos album tab was found.');
  await send('AA_SCAN', { tabId: tab.id });
}));
$('archive').addEventListener('click', () => action(async () => {
  const count = A.counts(job);
  if (!job || !confirm(`Archive ${count.pending} scanned album photo${count.pending === 1 ? '' : 's'}? They will stay in the album. A separate working tab will open.`)) return;
  await send('AA_ARCHIVE', { jobId: job.id });
}));
$('stop').addEventListener('click', () => action(async () => {
  await send('AA_STOP');
  $('status').textContent = 'Stop requested. Finishing the current check…';
}));
$('export').addEventListener('click', () => {
  if (!job) return;
  const blob = new Blob([JSON.stringify(job, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'album-archiver-progress.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[A.jobKey]) void refresh();
});
setInterval(() => void refresh(), 1000);
void refresh();
