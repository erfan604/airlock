// AIR-329: the hero media slot of /credit: a rendered card loop and its poster, in web/public/media like the landing's (encoded from the
// coordinator's Blender render of the card, 1280 wide, no audio). test/credit.test.tsx fails if CREDIT_MEDIA is true and a file is missing,
// or false while both files are there.
export const CREDIT_MEDIA = true;
export const CREDIT_LOOP = 'media/credit-card-loop.mp4';
export const CREDIT_POSTER = 'media/credit-card-poster.jpg';
export const CREDIT_MEDIA_ALT = 'A rendered loop of an AIRLOCK agent card.';
