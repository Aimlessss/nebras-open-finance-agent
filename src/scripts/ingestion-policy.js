// Public ingestion policy. Shared files may still be dependencies of public pages.
const POLICY_VERSION = 'public-docs-2'
function exclusionReason(route, version = '') {
  const parts = String(route).replace(/\\/g, '/').split('/').filter(Boolean)
  const blocked = new Set(['_dev', '_shared', 'internal', 'biopay'])
  if (parts.some(p => blocked.has(p.replace(/\.(vue|md)$/i, '').toLowerCase()))) {
    return 'Excluded public-ingestion path'
  }
  // Prerelease versions and explicit draft directories are not published-stable content.
  const draft = /^(?:drafts?|v?\d+(?:\.\d+)*(?:[-.](?:rc|alpha|beta|preview|draft|dev|snapshot)[\w.-]*))$/i
  if ([...parts.map(p => p.replace(/\.(vue|md)$/i, '')), String(version)].some(p => draft.test(p))) {
    return 'Draft or prerelease version'
  }
  return null
}
module.exports = { POLICY_VERSION, exclusionReason }
