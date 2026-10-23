/** `values.at(index)`, throwing instead of returning `undefined`. */
export function itemAt<T>(values: readonly T[], index: number): T {
  const value = values.at(index);
  if (value === undefined) {
    throw new RangeError(`index ${index} is outside ${values.length} items`);
  }
  return value;
}
