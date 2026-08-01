export function isAdminEmail(email: string): boolean {
  if (!email) return false

  const allowlist = (process.env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)

  return allowlist.includes(email.trim().toLowerCase())
}
