// Browser storage is only a convenience (remembering the API key between
// reloads); every access is guarded because it can be unavailable.
export function readStored(key: string): string {
  try {
    return window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function writeStored(key: string, value: string): void {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage blocked: the session simply won't be remembered.
  }
}
