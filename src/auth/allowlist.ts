// PURE allowlist check (design doc section 10). Client-side UX only;
// Firestore rules are the real protection.

export interface AuthUserLike {
  email: string | null;
  emailVerified: boolean;
}

export function isAllowedFor(user: AuthUserLike | null | undefined, allowedEmail: string): boolean {
  const allowed = allowedEmail.trim().toLowerCase();
  if (!user || !allowed || !user.emailVerified || !user.email) return false;
  return user.email.trim().toLowerCase() === allowed;
}

/** Redirect sign-in only when the auth helper is same-origin (nginx proxy), else popup. */
export function shouldUseRedirect(authDomain: string, host: string): boolean {
  return authDomain !== "" && authDomain.toLowerCase() === host.toLowerCase();
}
