(function () {
  'use strict';
  if (globalThis.__albumArchiverLoaded) return;
  globalThis.__albumArchiverLoaded = true;
  const A = globalThis.AlbumArchiver;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  let cancelled = false;
  let busy = false;

  function visible(element) {
    const style = getComputedStyle(element);
    return element.isConnected && !element.closest('[hidden],[aria-hidden="true"]') && style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0;
  }
  function disabled(element) {
    return element.disabled || element.getAttribute('aria-disabled') === 'true' || Boolean(element.closest('[inert]'));
  }
  function controls() {
    const found = [];
    const roots = [document];
    for (let index = 0; index < roots.length && index < 100; index++) {
      const root = roots[index];
      found.push(...root.querySelectorAll('button,[role="button"],[role="menuitem"]'));
      for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
    }
    return [...new Set(found)];
  }
  function names(element) {
    return [element.getAttribute('aria-label'), element.getAttribute('title'), element.innerText || element.textContent].filter(Boolean);
  }
  function matching(type, onlyVisible = true) {
    return controls().filter(element => (!onlyVisible || visible(element)) && names(element).some(name => A.matches(type, name)));
  }
  function unique(type) {
    const found = matching(type).filter(element => !disabled(element));
    if (found.length > 1) throw new Error(`More than one ${type} control is visible. Close extra dialogs and try again.`);
    return found[0] || null;
  }
  function navigation(type) {
    const candidates = matching(type, false);
    if (candidates.length) return candidates.some(element => visible(element) && !disabled(element)) ? 'ready' : 'end';
    // Photos may omit the edge button entirely. Only infer an edge when the
    // opposite recognized navigation control proves this is the photo viewer.
    const opposite = matching(type === 'next' ? 'previous' : 'next', false);
    return opposite.length ? 'end' : 'unknown';
  }
  function snapshot() {
    return { route: A.route(location.href), url: location.href, title: document.querySelector('h1')?.innerText?.trim() || document.title, previous: navigation('previous'), next: navigation('next') };
  }
  function ensurePhoto(expected) {
    const current = A.route(location.href);
    if (!current || current.kind !== 'photo' || current.photoId !== expected.photoId || current.account !== expected.account) {
      throw new Error('The working tab changed photo or account. No archive action was sent.');
    }
    return current;
  }
  async function openAlbum() {
    const current = A.route(location.href);
    if (current?.kind === 'album-photo') return snapshot();
    if (current?.kind !== 'album') throw new Error('Open one of your Google Photos albums first. Shared-link albums are not supported.');
    const links = [...document.querySelectorAll('a[href]')].filter(element => {
      const target = A.route(element.href);
      return visible(element) && target?.kind === 'album-photo' && target.albumId === current.albumId && target.account === current.account;
    });
    if (!links.length) throw new Error('Open a photo inside the album, then click Scan album again.');
    links[0].click();
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline && !cancelled) {
      const target = A.route(location.href);
      if (target?.kind === 'album-photo' && target.albumId === current.albumId && target.account === current.account) return snapshot();
      await sleep(100);
    }
    throw new Error(cancelled ? 'Stopped.' : 'The album photo viewer did not open. Open a photo manually and try again.');
  }
  async function archiveState(expected) {
    ensurePhoto(expected);
    if (cancelled) throw new Error('Stopped.');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      ensurePhoto(expected);
      if (cancelled) throw new Error('Stopped.');
      const archived = unique('unarchive');
      const archive = unique('archive');
      if (archived && archive) throw new Error('Conflicting archive controls are visible. No action was sent.');
      if (archived) return { state: 'archived' };
      if (archive) return { state: 'unarchived' };
      const more = unique('more');
      if (more) {
        more.click();
        await sleep(200);
        ensurePhoto(expected);
        const until = Math.min(deadline, Date.now() + 2000);
        while (Date.now() < until && !cancelled) {
          const undo = unique('unarchive');
          const action = unique('archive');
          if (undo && action) throw new Error('Conflicting archive controls are visible.');
          if (undo) return { state: 'archived' };
          if (action) return { state: 'unarchived' };
          await sleep(100);
          ensurePhoto(expected);
        }
        throw new Error('Archive / Unarchive was not found in the photo menu. Check the Photos interface language.');
      }
      await sleep(100);
    }
    throw new Error('The photo toolbar did not appear. No archive action was sent.');
  }
  async function archiveOne(expected) {
    if (busy) throw new Error('An archive action is already in progress.');
    busy = true;
    try {
      cancelled = false;
      const state = await archiveState(expected);
      if (state.state === 'archived') return { alreadyArchived: true, attempted: false };
      ensurePhoto(expected);
      if (cancelled) throw new Error('Stopped.');
      const control = unique('archive');
      if (!control) throw new Error('The archive control disappeared. No action was sent.');
      if (names(control).some(name => /delete|trash|move to (?:bin|trash)|remove from album|sil|çöp|radera|supprimer/i.test(name))) {
        throw new Error('The control has conflicting labels. No action was sent.');
      }
      control.click();
      return { attempted: true, alreadyArchived: false };
    } finally { busy = false; }
  }

  chrome.runtime.onMessage.addListener((message, _, reply) => {
    if (!message?.type?.startsWith('AA_PAGE_')) return;
    (async () => {
      switch (message.type) {
        case 'AA_PAGE_SNAPSHOT': return snapshot();
        case 'AA_PAGE_OPEN_ALBUM': cancelled = false; return openAlbum();
        case 'AA_PAGE_ARCHIVE': return archiveOne(message);
        case 'AA_PAGE_ARCHIVE_STATE': cancelled = false; return archiveState(message);
        case 'AA_PAGE_CANCEL': cancelled = true; return { stopped: true };
        default: throw new Error('Unknown page command.');
      }
    })().then(result => reply({ ok: true, ...result }), error => reply({ ok: false, error: error.message }));
    return true;
  });
})();
