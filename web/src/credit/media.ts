// AIR-329: the hero media slot of /credit: a rendered card loop and its poster, in web/public/media like the landing's. The files come from the
// coordinator's Blender render and are not in the repository yet, so the slot is off: a missing file is a 404 the browser logs as an error, and the
// page must stay clean without them. When credit-card-loop.mp4 and credit-card-poster.jpg are in web/public/media, set CREDIT_MEDIA to true
// (test/credit.test.tsx fails if it is true and a file is missing, or false while both files are there).
export const CREDIT_MEDIA = false;
export const CREDIT_LOOP = 'media/credit-card-loop.mp4';
export const CREDIT_POSTER = 'media/credit-card-poster.jpg';
export const CREDIT_MEDIA_ALT = 'A rendered loop of an AIRLOCK agent card.';
