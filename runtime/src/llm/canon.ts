// RFC 8785 for what a request holds: keys sorted by UTF-16 code units (the default string sort), strings and finite numbers
// through JSON.stringify (the ECMAScript number form the RFC requires), booleans, null, arrays, objects. Anything else
// cannot be hashed and throws. This is not AIR-122's `jcs`, which rejects booleans and floats: a JSON schema holds
// `additionalProperties: false` and a request holds `temperature: 0.7`.
export function canonicalJson(v: unknown): string {
  switch (typeof v) {
    case 'string':
      return JSON.stringify(v);
    case 'boolean':
      return v ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError('canonicalJson: NaN and infinities have no JSON form');
      return JSON.stringify(v);
    case 'object': {
      if (v === null) return 'null';
      if (Array.isArray(v)) return '[' + v.map((item: unknown) => canonicalJson(item)).join(',') + ']';
      const record = v as Record<string, unknown>;
      return '{' + Object.keys(record).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(record[k])).join(',') + '}';
    }
    default:
      // undefined, bigint, function, symbol
      throw new TypeError(`canonicalJson: a ${typeof v} has no JSON form`);
  }
}
