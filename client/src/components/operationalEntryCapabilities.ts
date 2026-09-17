const REQUIRED_OPERATIONAL_ENTRY_CAPABILITIES = [
  'document.view',
  'document.upload',
  'document.edit',
  'obligation.view',
] as const;

export function canStartOperationalDocumentEntry(capabilities: readonly string[]): boolean {
  return REQUIRED_OPERATIONAL_ENTRY_CAPABILITIES.every(capability => capabilities.includes(capability));
}
