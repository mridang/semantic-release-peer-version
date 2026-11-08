/**
 * The message of anything that was thrown. Errors without a message, such as
 * the `AggregateError` Node raises when a dual-stack connection is refused,
 * are described by their `code`, then by their first inner error, then by
 * their name.
 *
 * @param error A caught value, which is not necessarily an `Error`.
 * @returns Its message, or its string form when it is not an `Error`.
 */
export function messageOf(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (error.message !== '') {
    return error.message;
  }
  if ('code' in error && typeof error.code === 'string') {
    return error.code;
  }
  // Not `instanceof AggregateError`: the error may come from another realm.
  const [first] =
    'errors' in error && Array.isArray(error.errors) ? error.errors : [];
  return first === undefined ? error.name : messageOf(first);
}
