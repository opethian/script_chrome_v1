(function (root) {
  'use strict';
  const labels = {
    previous: ['Previous photo', 'Previous', 'Önceki fotoğraf', 'Önceki', 'Föregående foto', 'Föregående', 'Vorheriges Foto', 'Précédent', 'Photo précédente'],
    next: ['Next photo', 'Next', 'Sonraki fotoğraf', 'Sonraki', 'Nästa foto', 'Nästa', 'Nächstes Foto', 'Suivant', 'Photo suivante'],
    more: ['More options', 'More', 'More actions', 'Diğer seçenekler', 'Diğer', 'Fler alternativ', 'Weitere Optionen', 'Autres options'],
    archive: ['Archive', 'Archive photo', 'Archive photos', 'Move to archive', 'Arşivle', 'Arşive taşı', 'Arkivera', 'Flytta till arkivet', 'Archivieren', 'Ins Archiv verschieben', 'Archiver'],
    unarchive: ['Unarchive', 'Unarchive photo', 'Unarchive photos', 'Remove from archive', 'Arşivden çıkar', 'Arşivden kaldır', 'Avarkivera', 'Ta bort från arkivet', 'Aus Archiv entfernen', 'Aus dem Archiv entfernen', 'Désarchiver'],
  };
  const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\u0307/g, '').replace(/\s+/g, ' ').trim();
  const normalized = Object.fromEntries(Object.entries(labels).map(([key, values]) => [key, new Set(values.map(normalize))]));
  function route(value) {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (url.origin !== 'https://photos.google.com') return null;
    const album = url.pathname.match(/^(\/u\/\d+)?\/album\/([^/]+)(?:\/photo\/([^/]+))?\/?$/);
    if (album) return {
      kind: album[3] ? 'album-photo' : 'album', account: album[1] || '', albumId: album[2], photoId: album[3] || null,
      albumUrl: url.origin + (album[1] || '') + '/album/' + album[2],
      photoUrl: album[3] ? url.origin + (album[1] || '') + '/photo/' + album[3] : null,
    };
    const photo = url.pathname.match(/^(\/u\/\d+)?\/photo\/([^/]+)\/?$/);
    if (photo) return { kind: 'photo', account: photo[1] || '', photoId: photo[2], photoUrl: url.origin + (photo[1] || '') + '/photo/' + photo[2] };
    return null;
  }
  function counts(job) {
    const photos = job?.photos || [];
    return {
      total: photos.length,
      archived: photos.filter(photo => photo.status === 'archived').length,
      alreadyArchived: photos.filter(photo => photo.status === 'already-archived').length,
      pending: photos.filter(photo => photo.status === 'pending').length,
      uncertain: photos.filter(photo => photo.status === 'uncertain' || photo.status === 'processing').length,
    };
  }
  const api = { route, counts, normalize, labels, matches: (type, value) => normalized[type]?.has(normalize(value)) || false, jobKey: 'albumArchiverJob' };
  root.AlbumArchiver = api;
  if (typeof module !== 'undefined') module.exports = api;
})(globalThis);
