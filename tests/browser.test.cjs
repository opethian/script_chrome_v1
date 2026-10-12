const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { chromium } = require('playwright');
const A = require('../extension/shared.js');
const root = path.join(__dirname, '../extension');
let browser;
let scratch;

before(async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'album-archiver-tests-'));
  const executable = process.env.CHROMIUM_PATH || (fs.existsSync('/usr/lib/chromium/chromium') ? '/usr/lib/chromium/chromium' : undefined);
  browser = await chromium.launch({ executablePath: executable, headless: true, env: { ...process.env, XDG_CACHE_HOME: path.join(scratch, 'cache'), XDG_CONFIG_HOME: path.join(scratch, 'config') } });
});
after(async () => {
  if (browser) await browser.close();
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

function event() {
  return { listeners: [], addListener(fn) { this.listeners.push(fn); }, emit(...args) { for (const fn of this.listeners) fn(...args); } };
}
function chromeInPage() {
  const listeners = [];
  window.__fixtureMessage = message => new Promise((resolve, reject) => {
    let asyncReply = false;
    let replied = false;
    const reply = value => { replied = true; resolve(value); };
    for (const listener of listeners) if (listener(message, {}, reply) === true) asyncReply = true;
    if (!asyncReply && !replied) reject(new Error('No content handler: ' + message.type));
  });
  window.chrome = {
    runtime: { onMessage: { addListener: listener => listeners.push(listener) }, sendMessage: message => window.__fixtureBridge({ action: 'background', message }) },
    tabs: { query: () => window.__fixtureBridge({ action: 'query' }) },
    storage: { onChanged: { addListener() {} } },
  };
}

class Fixture {
  constructor(options = {}) {
    this.options = options;
    this.ids = options.ids || ['p1', 'p2', 'p3'];
    this.archived = new Set(options.archived || []);
    this.attempts = [];
    this.tabs = new Map();
    this.nextTab = 1;
    this.activeTab = null;
    this.store = options.initialJob ? { [A.jobKey]: structuredClone(options.initialJob) } : {};
    this.errors = [];
    this.trustedKeys = [];
    this.attached = new Set();
    this.stoppedOnce = false;
  }
  async init(start = '/album/a/photo/p1') {
    this.context = await browser.newContext();
    this.context.setDefaultTimeout(5000);
    await this.context.exposeBinding('__fixtureBridge', (_, request) => {
      if (request.action === 'background') return this.command(request.message);
      if (request.action === 'query') return [this.tabInfo(this.activeTab)];
      if (request.action === 'archive') {
        this.attempts.push(request.id);
        if (!this.options.failArchive) this.archived.add(request.id);
        return;
      }
      if (request.action === 'key') { this.trustedKeys.push(request.trusted); return; }
      throw new Error('Unknown fixture action');
    });
    await this.context.addInitScript(chromeInPage);
    await this.context.addInitScript({ content: `if(location.hostname==='photos.google.com'){\n${fs.readFileSync(path.join(root, 'shared.js'))}\n${fs.readFileSync(path.join(root, 'content.js'))}\n}` });
    await this.context.route(/^https?:\/\//, async route => {
      const url = new URL(route.request().url());
      if (url.hostname === 'photos.google.com') return route.fulfill({ contentType: 'text/html; charset=utf-8', body: this.html(url.href) });
      if (url.hostname === 'extension-fixture.invalid' && ['popup.html', 'popup.js', 'shared.js', 'style.css'].includes(url.pathname.slice(1))) {
        return route.fulfill({ contentType: url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.css') ? 'text/css' : 'text/html', body: fs.readFileSync(path.join(root, url.pathname.slice(1))) });
      }
      return route.abort();
    });
    this.createWorker();
    this.sourceId = await this.newTab('https://photos.google.com' + start, true);
    return this;
  }
  createWorker() {
    const runtimeMessages = event();
    const detachEvent = event();
    const api = {
      runtime: { id: 'fixture-extension', onMessage: runtimeMessages },
      storage: { local: {
        get: async key => ({ [key]: structuredClone(this.store[key]) }),
        set: async values => {
          Object.assign(this.store, structuredClone(values));
          const job = this.store[A.jobKey];
          if (this.options.stopAfterVerified && !this.stoppedOnce && job?.phase === 'archiving' && A.counts(job).archived >= this.options.stopAfterVerified) {
            this.stoppedOnce = true;
            await this.command({ type: 'AA_STOP' });
          }
        },
      } },
      tabs: {
        get: async id => this.tabInfo(id),
        create: async options => this.tabInfo(await this.newTab(options.url, options.active)),
        update: async (id, options) => { await this.tabs.get(id).goto(options.url); return this.tabInfo(id); },
        reload: async id => { await this.tabs.get(id).reload(); },
        sendMessage: async (id, message) => {
          const page = this.tabs.get(id);
          if (!page || page.isClosed()) throw new Error('Tab closed');
          return page.evaluate(message => window.__fixtureMessage(message), message);
        },
        onRemoved: event(),
      },
      debugger: {
        attach: async ({ tabId }) => { this.attached.add(tabId); },
        detach: async ({ tabId }) => { this.attached.delete(tabId); detachEvent.emit({ tabId }); },
        sendCommand: async ({ tabId }, method, parameters) => {
          assert.equal(method, 'Input.dispatchKeyEvent');
          const page = this.tabs.get(tabId);
          if (parameters.type === 'keyDown') await page.keyboard.down(parameters.key);
          else await page.keyboard.up(parameters.key);
        },
        onDetach: detachEvent,
      },
    };
    const context = vm.createContext({ chrome: api, console, crypto: webcrypto, URL, Date, setTimeout, clearTimeout });
    context.importScripts = name => vm.runInContext(fs.readFileSync(path.join(root, name), 'utf8'), context, { filename: name });
    vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), context, { filename: 'background.js' });
    this.messages = runtimeMessages;
  }
  async newTab(url, active) {
    const id = this.nextTab++;
    const page = await this.context.newPage();
    page.on('pageerror', error => this.errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    this.tabs.set(id, page);
    if (active) this.activeTab = id;
    await page.goto(url);
    return id;
  }
  tabInfo(id) {
    const page = this.tabs.get(id);
    if (!page || page.isClosed()) throw new Error('Tab closed');
    return { id, url: page.url(), status: 'complete' };
  }
  command(message, sender = { id: 'fixture-extension' }) {
    return new Promise((resolve, reject) => {
      let handled = false;
      for (const listener of this.messages.listeners) if (listener(message, sender, resolve) === true) handled = true;
      if (!handled) reject(new Error('No background handler'));
    });
  }
  async settled() {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const response = await this.command({ type: 'AA_GET_JOB' });
      if (!response.running) return response.job;
      await new Promise(resolve => setTimeout(resolve, 40));
    }
    throw new Error('Fixture operation timed out');
  }
  async scan() {
    const started = await this.command({ type: 'AA_SCAN', tabId: this.sourceId });
    assert.equal(started.ok, true, started.error);
    return this.settled();
  }
  async archive() {
    const job = this.store[A.jobKey];
    const started = await this.command({ type: 'AA_ARCHIVE', jobId: job.id });
    assert.equal(started.ok, true, started.error);
    return this.settled();
  }
  async close() { await this.context.close(); }
  html(url) {
    const route = A.route(url);
    const prefix = route?.account || '';
    if (route?.kind === 'album') return `<!doctype html><meta charset="utf-8"><h1>Fixture album</h1>${this.ids.map(id => `<a href="${prefix}/album/a/photo/${id}">Photo ${id}</a>`).join('')}`;
    const data = { ids: this.ids, archived: [...this.archived], prefix, options: this.options, labels: this.options.language === 'tr' ? { previous: 'Önceki fotoğraf', next: 'Sonraki fotoğraf', more: 'Diğer seçenekler', archive: 'Arşivle', unarchive: 'Arşivden çıkar' } : { previous: 'Previous photo', next: 'Next photo', more: 'More options', archive: 'Archive', unarchive: 'Unarchive' } };
    return `<!doctype html><html><head><meta charset="utf-8"><title>Fixture Photos</title></head><body><h1>Fixture album</h1><div id="viewer"></div><script>
      const fixture = ${JSON.stringify(data)};
      const viewer = document.getElementById('viewer');
      function currentId(){ return location.pathname.split('/').filter(Boolean).at(-1); }
      function render(){
        const id = currentId();
        const inAlbum = location.pathname.includes('/album/');
        const index = fixture.ids.indexOf(id);
        if(inAlbum){
          viewer.innerHTML = fixture.options.hideNavigation ? '<p>Unknown viewer</p>' : '<button id="previous" aria-label="'+fixture.labels.previous+'" '+(index===0?'disabled':'')+'>Previous</button><button id="next" aria-label="'+fixture.labels.next+'" '+(index===fixture.ids.length-1?'disabled':'')+'>Next</button>';
          return;
        }
        const archived = fixture.archived.includes(id);
        const label = archived ? fixture.labels.unarchive : fixture.labels.archive;
        viewer.innerHTML = '<button id="more" aria-label="'+fixture.labels.more+'">More</button><div id="menu" role="menu" hidden><button id="archive-action" role="menuitem" aria-label="'+(fixture.options.misleadingArchive?'Delete':label)+'">'+label+'</button>'+(fixture.options.ambiguousArchive?'<button role="menuitem" aria-label="'+label+'">'+label+'</button>':'')+'</div>';
        document.getElementById('more').onclick=()=>{const m=document.getElementById('menu');m.hidden=!m.hidden;};
        document.getElementById('archive-action').onclick=async()=>{
          if(archived){ await window.__fixtureBridge({action:'archive',id:'UNARCHIVE:'+id}); return; }
          await window.__fixtureBridge({action:'archive',id});
          if(fixture.options.navigateAfterArchive){history.pushState({},'',fixture.prefix+'/photos');viewer.innerHTML='Photos feed';}
        };
      }
      function step(direction){
        if(!location.pathname.includes('/album/'))return;
        const index=fixture.ids.indexOf(currentId());
        const next=index+(direction==='ArrowRight'?1:-1);
        if(next<0||next>=fixture.ids.length)return;
        const album=fixture.options.crossAlbumOnNext&&direction==='ArrowRight'?'other':'a';
        const id=fixture.options.repeatNext&&next===fixture.ids.length-1?fixture.ids[0]:fixture.ids[next];
        history.pushState({},'',fixture.prefix+'/album/'+album+'/photo/'+id);
        render();
      }
      window.addEventListener('keydown',event=>{if(event.key==='ArrowLeft'||event.key==='ArrowRight'){window.__fixtureBridge({action:'key',trusted:event.isTrusted});step(event.key);}});
      render();
    </script></body></html>`;
  }
}

async function using(options, run, start) {
  const fixture = await new Fixture(options).init(start);
  try { await run(fixture); assert.deepEqual(fixture.errors, []); assert.equal(fixture.attached.size, 0); }
  finally { await fixture.close(); }
}

test('scan rewinds from a middle photo and captures exact album IDs', () => using({}, async fixture => {
  const job = await fixture.scan();
  assert.equal(job.phase, 'ready');
  assert.equal(job.scanComplete, true);
  assert.deepEqual(job.photos.map(photo => photo.id), ['p1', 'p2', 'p3']);
  assert.deepEqual(fixture.attempts, []);
  assert.ok(fixture.trustedKeys.length > 0);
  assert.ok(fixture.trustedKeys.every(Boolean));
}, '/album/a/photo/p2'));

test('album overview can open the first thumbnail and complete a scan', () => using({}, async fixture => {
  const job = await fixture.scan();
  assert.equal(job.phase, 'ready');
  assert.equal(job.photos.length, 3);
}, '/album/a'));

test('single-photo album completes without keyboard navigation', () => using({ ids: ['p1'] }, async fixture => {
  assert.equal((await fixture.scan()).photos.length, 1);
  assert.equal(fixture.trustedKeys.length, 0);
}));

test('archiving verifies every photo after a viewer closes and preserves the album', () => using({ navigateAfterArchive: true }, async fixture => {
  await fixture.scan();
  const albumUrl = fixture.tabInfo(fixture.sourceId).url;
  const job = await fixture.archive();
  assert.equal(job.phase, 'done');
  assert.equal(A.counts(job).archived, 3);
  assert.deepEqual(fixture.attempts, ['p1', 'p2', 'p3']);
  assert.equal(fixture.tabInfo(fixture.sourceId).url, albumUrl);
}));

test('already archived photos are verified without invoking Unarchive', () => using({ archived: ['p1', 'p3'] }, async fixture => {
  await fixture.scan();
  const job = await fixture.archive();
  assert.equal(job.phase, 'done');
  assert.equal(A.counts(job).alreadyArchived, 2);
  assert.deepEqual(fixture.attempts, ['p2']);
}));

test('Turkish labels and a secondary account remain correctly scoped', () => using({ language: 'tr', ids: ['p1', 'p2'] }, async fixture => {
  const scanned = await fixture.scan();
  assert.equal(scanned.photos[0].url, 'https://photos.google.com/u/2/photo/p1');
  const job = await fixture.archive();
  assert.equal(job.phase, 'done');
  assert.equal(job.account, '/u/2');
}, '/u/2/album/a/photo/p1'));

test('uncertain archive stops the batch and cannot be automatically retried', () => using({ failArchive: true }, async fixture => {
  await fixture.scan();
  const job = await fixture.archive();
  assert.equal(job.phase, 'error');
  assert.equal(A.counts(job).archived, 0);
  assert.equal(A.counts(job).uncertain, 1);
  assert.deepEqual(fixture.attempts, ['p1']);
  const retry = await fixture.command({ type: 'AA_ARCHIVE', jobId: job.id });
  assert.equal(retry.ok, false);
  assert.match(retry.error, /uncertain/);
}));

test('stop finishes the current verification and leaves pending photos untouched', () => using({ stopAfterVerified: 1 }, async fixture => {
  await fixture.scan();
  const job = await fixture.archive();
  assert.equal(job.phase, 'stopped');
  assert.equal(A.counts(job).archived, 1);
  assert.equal(A.counts(job).pending, 2);
  assert.deepEqual(fixture.attempts, ['p1']);
  const resumed = await fixture.archive();
  assert.equal(resumed.phase, 'done');
  assert.deepEqual(fixture.attempts, ['p1', 'p2', 'p3']);
}));

test('an unexpected album switch aborts scanning with no archive changes', () => using({ crossAlbumOnNext: true }, async fixture => {
  const job = await fixture.scan();
  assert.equal(job.phase, 'error');
  assert.equal(job.scanComplete, false);
  assert.deepEqual(fixture.attempts, []);
}));

test('repeating navigation cannot be mistaken for a complete album', () => using({ repeatNext: true }, async fixture => {
  const job = await fixture.scan();
  assert.equal(job.phase, 'error');
  assert.equal(job.scanComplete, false);
  assert.match(job.error, /repeated/);
}));

test('ambiguous archive controls stop without clicking either one', () => using({ ambiguousArchive: true, ids: ['p1'] }, async fixture => {
  await fixture.scan();
  const job = await fixture.archive();
  assert.equal(job.phase, 'error');
  assert.equal(A.counts(job).pending, 1);
  assert.deepEqual(fixture.attempts, []);
}));

test('a misleading Archive/Delete control is never clicked', () => using({ misleadingArchive: true, ids: ['p1'] }, async fixture => {
  await fixture.scan();
  const job = await fixture.archive();
  assert.equal(job.phase, 'error');
  assert.deepEqual(fixture.attempts, []);
}));

test('worker restart flags an in-flight photo instead of resuming it', () => using({ initialJob: { id: 'old', phase: 'archiving', scanComplete: true, photos: [{ id: 'p1', status: 'processing' }, { id: 'p2', status: 'pending' }] } }, async fixture => {
  const state = await fixture.command({ type: 'AA_GET_JOB' });
  assert.equal(state.running, false);
  assert.equal(state.job.phase, 'interrupted');
  assert.equal(state.job.photos[0].status, 'uncertain');
  assert.deepEqual(fixture.attempts, []);
}));

test('popup runs scan, batch confirmation, progress, and completion', () => using({ ids: ['p1'] }, async fixture => {
  const popup = await fixture.context.newPage();
  let confirmations = 0;
  popup.on('dialog', async dialog => { confirmations += 1; await dialog.accept(); });
  popup.on('pageerror', error => fixture.errors.push(error.message));
  await popup.goto('https://extension-fixture.invalid/popup.html');
  await popup.waitForFunction(() => !document.getElementById('scan').disabled);
  assert.equal(await popup.locator('#archive').isDisabled(), true);
  await popup.locator('#scan').click();
  await popup.waitForFunction(() => !document.getElementById('archive').disabled);
  assert.equal(await popup.locator('#total').innerText(), '1');
  await popup.locator('#archive').click();
  const deadline = Date.now() + 5000;
  while (fixture.store[A.jobKey].phase === 'ready' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
  const job = await fixture.settled();
  assert.equal(job.phase, 'done');
  assert.equal(confirmations, 1);
  await popup.waitForFunction(() => document.getElementById('verified').textContent === '1');
  assert.equal(await popup.locator('#archive').isDisabled(), true);
  await popup.close();
}));

test('a page cannot trigger background archiving on its own', () => using({}, async fixture => {
  const reply = await fixture.command({ type: 'AA_SCAN', tabId: fixture.sourceId }, { id: 'fixture-extension', tab: { id: fixture.sourceId } });
  assert.equal(reply.ok, false);
  assert.deepEqual(fixture.attempts, []);
}));
