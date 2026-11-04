/** Diagnostic URLs must never retain credential-bearing query strings or fragments. */
export function requestPath(value: string): string {
  return value.split(/[?#]/, 1)[0] || '/';
}
