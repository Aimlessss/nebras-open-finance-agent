#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { SCHEMA_VERSION, PARSER_VERSION, CHUNKER_VERSION } = require('./chunk-contract')

function main() {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source-root', '--output', '--files'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: prepare.js [--source-root PATH] [--output NEW_DIRECTORY] [--files JSON_ARRAY_FILE]')
    options[args[i]] = args[i + 1]
  }
  const root = fs.realpathSync(path.resolve(options['--source-root'] || process.env.SOURCE_ROOT || path.join(__dirname, '../../../community-standards')))
  const pages = path.join(root, 'src/pages')
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const commit = git('rev-parse', 'HEAD')
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Source checkout must be clean so source_commit accurately identifies its content.')
  const output = path.resolve(options['--output'] || path.join(__dirname, '../../runs', `${Date.now()}-${commit.slice(0, 8)}`))
  if (fs.existsSync(output)) throw new Error('Output directory already exists. Choose a fresh directory to avoid stale artifacts.')
  const selected = Boolean(options['--files'])
  let files
  if (selected) {
    files = JSON.parse(fs.readFileSync(options['--files'], 'utf8'))
    if (!Array.isArray(files) || !files.every(f => typeof f === 'string')) throw new Error('--files must contain a JSON array of repository-relative source paths.')
  } else {
    const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
      const p = path.join(dir, e.name)
      return e.isDirectory() ? walk(p) : [path.relative(root, p).split(path.sep).join('/')]
    })
    files = walk(pages).filter(f => f.endsWith('.vue') && !f.includes('/_shared/'))
  }
  const manifest = {
    schema_version: SCHEMA_VERSION, parser_version: PARSER_VERSION, chunker_version: CHUNKER_VERSION,
    source_repo: 'Nebras-Open-Finance/community-standards', source_commit: commit,
    mode: selected ? 'selected' : 'full', status: 'running', documents: [], failures: [],
    notes: ['Static Vue extraction only. Warnings and zero-chunk outputs require review. Missing files are failures, never deletion instructions. This is preparation state, not an ingestion checkpoint.'],
  }
  const pointIds = new Set()
  fs.mkdirSync(output, { recursive: true })
  for (const file of [...new Set(files)].sort()) {
    try {
      if (!file.startsWith('src/pages/') || !file.endsWith('.vue') || file.split('/').some(p => p === '..' || p === '_shared') || file.includes('\\')) throw new Error('Expected a page Vue path under src/pages, excluding _shared.')
      const input = fs.realpathSync(path.join(root, file))
      if (!input.startsWith(pages + path.sep)) throw new Error('Source escapes pages directory.')
      const stem = file.slice('src/pages/'.length, -4)
      const parsed = path.join(output, 'parsed-output', stem + '.json')
      const chunked = path.join(output, 'chunk-output', stem + '.chunks.json')
      const env = { ...process.env, SOURCE_ROOT: root, SOURCE_COMMIT: commit }
      for (const [script, a, b] of [['parser.js', input, parsed], ['chunker.js', parsed, chunked]]) {
        execFileSync(process.execPath, [path.join(__dirname, script), a, b], { env, stdio: ['ignore', 'ignore', 'pipe'] })
      }
      const document = JSON.parse(fs.readFileSync(parsed, 'utf8'))
      const data = JSON.parse(fs.readFileSync(chunked, 'utf8'))
      for (const c of data.chunks) {
        if (pointIds.has(c.id)) throw new Error('Duplicate point ID across documents: ' + c.id)
      }
      for (const c of data.chunks) pointIds.add(c.id)
      manifest.documents.push({
        document_id: document.id, source_file: file, source_hash: document.source.hash,
        url: document.metadata.url, dependencies: document.source.dependencies,
        warnings: [...document.source.extraction_warnings, ...(data.chunks.length ? [] : ['No chunks extracted; review before any deletion.'])],
        chunk_file: path.relative(output, chunked),
        chunks: data.chunks.map(c => ({ id: c.id, chunk_key: c.chunk_key, content_hash: c.content_hash })),
      })
    } catch (error) {
      manifest.failures.push({ source_file: file, error: error.message })
    }
  }
  if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain', '--untracked-files=all')) manifest.failures.push({ error: 'Source checkout changed during preparation.' })
  manifest.status = manifest.failures.length ? 'failed' : 'complete'
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${manifest.status}: ${manifest.documents.length} documents, ${manifest.failures.length} failures. ${output}`)
  if (manifest.failures.length) process.exitCode = 1
}
try { main() } catch (error) { console.error(error.message); process.exitCode = 1 }
