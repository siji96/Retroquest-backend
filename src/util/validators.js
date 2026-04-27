// Server-side input validators. Defense-in-depth — the frontend escapes on render,
// but we still want the data at rest to be clean so exports / logs / future clients
// don't get poisoned.
//
// Avatars are now NFT short-ids (`durian-<n>` / `token-<n>`) from the Durian the
// Elephant collection on Bitkub Chain. Frontend stores and transmits the short
// id; rendering layers expand it to /nft/<id>.jpeg. Keep in sync with
// /Users/fox.sucharkree/Retroquest/src/constants.js AVATARS.

const NFT_AVATARS = new Set([
  'durian-1','durian-2','durian-3','durian-4','durian-5','durian-6','durian-7','durian-8',
  'token-1','token-131072','token-262144','token-393216','token-524288','token-655360',
  'token-786432','token-917504','token-1048576','token-1179648','token-1310720','token-1441792',
  'token-1572864','token-1703936','token-1835008','token-1966080',
]);
const RESERVED_AVATARS = new Set([
  '🕵️',   // is_anonymous mask (server-applied during card reveal)
  '🦄',   // default fallback when a bot / malformed client picks nothing
]);

const DEFAULT_AVATAR = 'durian-1';

export function sanitizeAvatar(a) {
  if (typeof a !== 'string') return DEFAULT_AVATAR;
  if (NFT_AVATARS.has(a)) return a;
  if (RESERVED_AVATARS.has(a)) return a;
  return DEFAULT_AVATAR;
}
