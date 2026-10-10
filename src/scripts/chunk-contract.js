const { createHash } = require('node:crypto')
const SCHEMA_VERSION = 2
const PARSER_VERSION = '2'
const CHUNKER_VERSION = '2'
const hashText = text => createHash('sha256').update(text, 'utf8').digest('hex')

// Fixed UUIDv5 namespace for this ingestion contract. Never change after indexing.
function pointId(repo, documentId, chunkKey) {
  const namespace = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex')
  const bytes = createHash('sha1').update(namespace)
    .update(JSON.stringify([repo, documentId, chunkKey])).digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const h = bytes.toString('hex')
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`
}
function pageUrl(documentId) {
  if (!documentId || /[\[\]?#]/.test(documentId) || documentId.split('/').some(p => p === '..' || p === '_shared')) return null
  return new URL(documentId.split('/').map(encodeURIComponent).join('/'), 'https://nebras-open-finance.com/').href
}
function finalizeChunks(document, chunks) {
  const seen = new Map()
  return chunks.map(chunk => {
    const m = chunk.metadata
    const base = JSON.stringify(chunk.type === 'intro' ? ['intro'] :
      chunk.type === 'navigation' ? ['navigation', m.url || m.navigation_title] :
      [chunk.type, m.anchor || [m.category || '', m.section || ''], m.subsection || ''])
    const occurrence = seen.get(base) || 0
    seen.set(base, occurrence + 1)
    const key = `${base}:${occurrence}`
    const repo = document.source.repo.includes('/') ? document.source.repo : `Nebras-Open-Finance/${document.source.repo}`
    return {
      ...chunk,
      id: pointId(repo, document.id, key),
      chunk_key: key,
      content_hash: hashText(chunk.text),
      schema_version: SCHEMA_VERSION,
      metadata: {
        ...m,
        ...(chunk.type === 'navigation' ? { navigation_url: m.url } : {}),
        source_repo: repo,
        source_commit: document.source.commit || null,
        source_hash: document.source.hash || null,
        url: document.metadata?.url ?? pageUrl(document.id),
        doc_version: document.metadata?.doc_version || 'unversioned',
        parser_version: document.source.parser_version || 'legacy',
        chunker_version: CHUNKER_VERSION,
        dependencies: document.source.dependencies || [],
        extraction_warnings: document.source.extraction_warnings || [],
      },
    }
  })
}
module.exports = { SCHEMA_VERSION, PARSER_VERSION, CHUNKER_VERSION, hashText, pointId, pageUrl, finalizeChunks }
