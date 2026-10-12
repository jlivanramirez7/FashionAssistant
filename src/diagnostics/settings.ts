// "Save troubleshooting data" toggle, per device (localStorage). Off by default.
const KEY = "fa.saveDiagnostics";

export function diagnosticsEnabled(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setDiagnosticsEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* private mode: the toggle just won't stick */
  }
}
