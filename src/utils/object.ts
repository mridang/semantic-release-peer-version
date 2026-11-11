/**
 * @file Reads properties of untrusted objects without trusting their shape.
 */

/**
 * Whether a value is a plain object: not null and not an array.
 * @param value - Value to check.
 * @returns True for objects with string keys.
 * @example
 * ```ts
 * isRecord({ a: 1 }); // true
 * isRecord([1]); // false
 * ```
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an own string property of an untrusted object; inherited members are
 * ignored.
 * @param record - The object.
 * @param key - Property name.
 * @returns The value when it is a string, otherwise undefined.
 * @example
 * ```ts
 * stringAt({ name: 'v1' }, 'name'); // 'v1'
 * stringAt({ n: 1 }, 'n'); // undefined
 * ```
 */
export function stringAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

/**
 * Read a number property of an untrusted object.
 * @param record - The object.
 * @param key - Property name.
 * @returns The value when it is a number, otherwise undefined.
 * @example
 * ```ts
 * numberAt({ n: 3 }, 'n'); // 3
 * ```
 */
export function numberAt(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = Object.hasOwn(record, key) ? record[key] : undefined;
  return typeof value === 'number' ? value : undefined;
}
