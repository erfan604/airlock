// The closed JSON schema sent with every extraction (AIR-142): exactly the requested fields, all required, nothing extra. Enum
// values come from plan-written schemas, so each distinct plan compiles a new grammar on the engine; the typed validator stays the
// guarantee either way.
import { enumMembers } from './validators.ts';

function propertyOf(type: string): object {
  const members = enumMembers(type);
  if (members !== null) return { enum: [...members, null] };
  switch (type) {
    case 'address':
    case 'text':
      return { type: ['string', 'null'], maxLength: 200 };
    case 'amount':
    case 'number':
      return { type: ['string', 'null'], maxLength: 80 };
    case 'bool':
      return { type: ['boolean', 'null'] };
    default:
      // the validator turns any other type name into null
      return { type: ['string', 'null'] };
  }
}

export function extractionSchema(schema: Readonly<Record<string, string>>): object {
  const keys = Object.keys(schema);
  return {
    type: 'object',
    properties: Object.fromEntries(keys.map((k) => [k, propertyOf(String(schema[k]))])),
    required: keys,
    additionalProperties: false,
  };
}
