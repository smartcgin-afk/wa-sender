export function shouldRestoreWhatsAppSession(sessionDirectoryExists, manuallyDisconnected) {
  return Boolean(sessionDirectoryExists && !manuallyDisconnected);
}

export function shouldStartFreshWhatsAppSession(manuallyDisconnected) {
  return Boolean(manuallyDisconnected);
}
