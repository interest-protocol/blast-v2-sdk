/** The JSON Schema subset used by the pinned partner contract. No coercion. */
export interface Schema {
  $ref?: string;
  type?: string | string[];
  properties?: Record<string, Schema>;
  required?: string[];
  additionalProperties?: boolean | Schema;
  items?: boolean | Schema;
  prefixItems?: Schema[];
  oneOf?: Schema[];
  anyOf?: Schema[];
  allOf?: Schema[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  propertyNames?: Schema;
  maxProperties?: number;
  format?: string;
  description?: string;
  title?: string;
  default?: unknown;
  discriminator?: unknown;
  examples?: unknown;
  example?: unknown;
}

export function matchesSchema(
  value: unknown,
  schema: Schema | boolean,
  schemas: Record<string, Schema>,
  depth = 0,
): boolean {
  if (depth > 64 || schema === false) {
    return false;
  }
  if (schema === true) {
    return true;
  }
  const matchesChild = (item: unknown, rule: Schema | boolean) =>
    matchesSchema(item, rule, schemas, depth + 1);
  if (schema.$ref) {
    const target = schemas[schema.$ref.replace("#/components/schemas/", "")];
    return target !== undefined && matchesChild(value, target);
  }
  if ("const" in schema && value !== schema.const) {
    return false;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return false;
  }
  if (schema.oneOf && schema.oneOf.filter((rule) => matchesChild(value, rule)).length !== 1) {
    return false;
  }
  if (schema.anyOf && !schema.anyOf.some((rule) => matchesChild(value, rule))) {
    return false;
  }
  if (schema.allOf && !schema.allOf.every((rule) => matchesChild(value, rule))) {
    return false;
  }
  if (Array.isArray(schema.type)) {
    return schema.type.some((type) => matchesChild(value, { ...schema, type }));
  }
  switch (schema.type) {
    case "null":
      return value === null;
    case "boolean":
      return typeof value === "boolean";
    case "integer":
    case "number":
      return (
        typeof value === "number" &&
        Number.isFinite(value) &&
        (schema.type !== "integer" || Number.isSafeInteger(value)) &&
        (schema.minimum === undefined || value >= schema.minimum) &&
        (schema.maximum === undefined || value <= schema.maximum)
      );
    case "string":
      return (
        typeof value === "string" &&
        (schema.minLength === undefined || [...value].length >= schema.minLength) &&
        (schema.maxLength === undefined || [...value].length <= schema.maxLength) &&
        (!schema.pattern || new RegExp(schema.pattern).test(value))
      );
    case "array":
      return Array.isArray(value) && matchesArray(value, schema, matchesChild);
    case "object":
      return (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        matchesObject(value as Record<string, unknown>, schema, matchesChild)
      );
    default:
      return true;
  }
}

function matchesArray(
  value: unknown[],
  schema: Schema,
  matchesChild: (value: unknown, rule: Schema | boolean) => boolean,
): boolean {
  if (
    (schema.minItems !== undefined && value.length < schema.minItems) ||
    (schema.maxItems !== undefined && value.length > schema.maxItems)
  ) {
    return false;
  }
  if (
    schema.uniqueItems &&
    new Set(value.map((item) => JSON.stringify(item))).size !== value.length
  ) {
    return false;
  }
  return value.every((item, index) =>
    matchesChild(item, schema.prefixItems?.[index] ?? schema.items ?? true),
  );
}

function matchesObject(
  value: Record<string, unknown>,
  schema: Schema,
  matchesChild: (value: unknown, rule: Schema | boolean) => boolean,
): boolean {
  const keys = Object.keys(value);
  if (
    schema.required?.some((key) => !Object.hasOwn(value, key)) ||
    (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
  ) {
    return false;
  }
  return keys.every((key) => {
    if (schema.propertyNames && !matchesChild(key, schema.propertyNames)) {
      return false;
    }
    const rule = Object.hasOwn(schema.properties ?? {}, key)
      ? schema.properties?.[key]
      : schema.additionalProperties;
    return matchesChild(value[key], rule ?? true);
  });
}
