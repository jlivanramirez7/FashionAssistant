// PURE allowlist check (design doc section 10). Client-side UX only;
// the server enforces the allowlist on every request.

export interface AuthUserLike {
  email: string | null;
  emailVerified: boolean;
}

export function isAllowedFor(user: AuthUserLike | null | undefined, allowedEmail: string): boolean {
  const allowed = allowedEmail.trim().toLowerCase();
  if (!user || !allowed || !user.emailVerified || !user.email) return false;
  return user.email.trim().toLowerCase() === allowed;
}
