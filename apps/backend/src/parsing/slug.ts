/**
 * Turn a printed label into the key a parsed field carries.
 *
 * This lives on its own because two different places have to agree on it exactly. The parser
 * reads a tank or attendant label off the page and produces `tank:<slug>:book_stock` and
 * `attendant:<slug>:expected`; the station settings screen takes the label a human types and
 * has to produce the *same* key, or the master list an owner fills in silently fails to line
 * up with the reports it was created for. Two copies of this function would drift, and the
 * symptom would be a tank that exists but is never matched — which looks like a parser bug
 * from every angle, and is not one.
 *
 * Uppercase alphanumerics joined by underscores, capped at 40 characters: "Tank 1" becomes
 * `TANK_1`, "J. Mwangi" becomes `J_MWANGI`.
 */
export function slugify(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * The identity a tank label has on both sides of the app.
 *
 * `slugify` alone does not make the two sides agree for tanks, and the reason is the shape of
 * the label rather than a bug in either caller. On the page the row reads
 *
 *     TANK 1 PMS 12,000 11,500
 *
 * and the parser takes the identifier after the word TANK, so the field it stores is
 * `tank:1:book_stock` — keyed `1`. In station settings a human types the same tank's name as
 * "Tank 1", and `slugify` turns *that* into `TANK_1`. Two derivations, both defensible, and
 * no parsed reading will ever carry the key the settings screen wrote. The symptom is a tank
 * that is configured, visible in settings and permanently unmatched by every report — which
 * reads as a parser bug from every angle and is not one.
 *
 * So the comparison is made on the part that is actually the tank's identity: the token after
 * "TANK", with any separator that follows it. `1`, `TANK 1` and `TANK_1` are the same tank;
 * `A` and `TANK_A` are the same tank.
 *
 * A slug that is *only* the word TANK has nothing left to compare once stripped, and is
 * returned unchanged rather than as an empty string — otherwise it would collide with every
 * other such slug and the first one indexed would answer for all of them.
 *
 * The strip needs a separator after "TANK", so a label whose own identifier begins with those
 * letters — a tank named "Tanker 1", keyed `TANKER_1` — is left alone rather than being cut
 * down to `ER1`. That case still will not match the parser, which keys the row `TANKER 1 PMS …`
 * as `TANKER`; it is not resolvable by guessing, and the escape hatch is that the leakage
 * screen reports the parser's key under `unmapped` so the tank can be created against it
 * exactly.
 */
export function tankIdentity(slug: string): string {
  const normalised = slug
    .trim()
    .toUpperCase()
    .replace(/^TANK[\s_-]+/, '')
    .replace(/[^A-Z0-9]/g, '');

  return normalised.length > 0 ? normalised : slug.trim().toUpperCase();
}
