/** Today's usage:tasks: every ask reads. */
export function oneReadingAtATime<Q, T>(read: (query: Q) => Promise<T>, _keyOf: (query: Q) => string): (query: Q) => Promise<T> {
  return read;
}
