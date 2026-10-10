#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync, execFile } = require('node:child_process')
const { promisify } = require('node:util')
const execute = promisify(execFile)
const {loadRun} = require('./embed-upload')
const {reusableDocument,copyDocument} = require('./reuse-document')
const { generatedApiDocs } = require('./generated-docs')
const { SCHEMA_VERSION, PARSER_VERSION, CHUNKER_VERSION } = require('./chunk-contract')

async function main() {
  const args = process.argv.slice(2)
  const options = {}
  for (let i = 0; i < args.length; i += 2) {
    if (!['--source-root', '--output', '--files', '--scope', '--previous'].includes(args[i]) || !args[i + 1]) throw new Error('Usage: prepare.js [--source-root PATH] [--output NEW_DIRECTORY] [--files JSON_ARRAY_FILE] [--scope public-docs|all] [--previous FULL_MANIFEST]')
    options[args[i]] = args[i + 1]
  }
  const root = fs.realpathSync(path.resolve(options['--source-root'] || process.env.SOURCE_ROOT || path.join(__dirname, '../../../community-standards')))
  const pages = path.join(root, 'src/pages')
  const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim()
  const commit = git('rev-parse', 'HEAD')
  if (git('status', '--porcelain', '--untracked-files=all')) throw new Error('Source checkout must be clean so source_commit accurately identifies its content.')
  const output = path.resolve(options['--output'] || path.join(__dirname, '../../runs', `${Date.now()}-${commit.slice(0, 8)}`))
  if (fs.existsSync(output)) throw new Error('Output directory already exists. Choose a fresh directory to avoid stale artifacts.')
  const scope = options['--scope'] || 'public-docs'
  if (!['public-docs', 'all'].includes(scope)) throw new Error('--scope must be public-docs or all')
  const previous=options['--previous'] ? loadRun(options['--previous']) : null
  if(previous && (options['--files'] || previous.manifest.mode!=='full' || previous.manifest.scope!==scope || previous.manifest.source_repo!=='Nebras-Open-Finance/community-standards'))throw new Error('--previous requires a full manifest of the same source and scope; do not combine with --files.')
  if(previous && previous.manifest.source_commit!==commit) {
    try { git('merge-base','--is-ancestor',previous.manifest.source_commit,commit) }
    catch { throw new Error('Previous source commit must be an ancestor of this checkout. Fetch source history first.') }
  }
  const compatible=previous && previous.manifest.parser_version===PARSER_VERSION && previous.manifest.chunker_version===CHUNKER_VERSION
  const previousDocs=new Map(compatible ? previous.manifest.documents.map(d=>[d.source_file,d]) : [])
  let reused=0
  let excluded = []
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
    files = walk(pages).filter(f => /\.(vue|md)$/.test(f) && !f.includes('/_shared/'))
    const discovered = [...files]
    if (scope === 'public-docs') files = files.filter(f => /src\/pages\/(tech|knowledge-base)\//.test(f) && !/[\[\]]/.test(f) && !/\/submission(?:\/|\.)/.test(f))
    excluded = discovered.filter(f => !files.includes(f)).map(source_file => ({source_file,reason: /\/submission(?:\/|\.)/.test(source_file) ? 'Interactive submission form' : /[\[\]]/.test(source_file) ? 'Dynamic route: API endpoints expanded via registry; release registries require separate extraction' : 'Outside public technical docs and knowledge-base scope'}))
  }
  const manifest = {
    schema_version: SCHEMA_VERSION, parser_version: PARSER_VERSION, chunker_version: CHUNKER_VERSION,
    source_repo: 'Nebras-Open-Finance/community-standards', source_commit: commit,
    mode: selected ? 'selected' : 'full', scope, excluded, notes_version: 1, status: 'running', documents: [], failures: [],
    notes: ['Static Vue extraction only. Warnings and zero-chunk outputs require review. Missing files are failures, never deletion instructions. This is preparation state, not an ingestion checkpoint.'],
  }
  const pointIds = new Set()
  fs.mkdirSync(output, { recursive: true })
  const orderedFiles = [...new Set(files)].sort()
  async function processFile(file) {
    try {
      if (!file.startsWith('src/pages/') || !/\.(vue|md)$/.test(file) || file.split('/').some(p => p === '..' || p === '_shared') || file.includes('\\')) throw new Error('Expected a page Vue path under src/pages, excluding _shared.')
      const before=previousDocs.get(file)
      if(before && reusableDocument(before,root)) {
        const doc=copyDocument(before,previous.root,output,commit)
        for(const c of doc.chunks){if(pointIds.has(c.id))throw new Error('Duplicate reused point ID: '+c.id);pointIds.add(c.id)}
        manifest.documents.push(doc);reused++;return
      }
      const input = fs.realpathSync(path.join(root, file))
      if (!input.startsWith(pages + path.sep)) throw new Error('Source escapes pages directory.')
      const stem = file.slice('src/pages/'.length).replace(/\.(vue|md)$/,'')
      const parsed = path.join(output, 'parsed-output', stem + '.json')
      const chunked = path.join(output, 'chunk-output', stem + '.chunks.json')
      const env = { ...process.env, SOURCE_ROOT: root, SOURCE_COMMIT: commit }
      for (const [script, a, b] of [[file.endsWith('.md') ? 'markdown-parser.js' : 'parser.js', input, parsed], ['chunker.js', parsed, chunked]]) {
        await execute(process.execPath, [path.join(__dirname, script), a, b], { env, maxBuffer: 32 * 1024 * 1024 })
      }
      const document = JSON.parse(fs.readFileSync(parsed, 'utf8'))
      const data = JSON.parse(fs.readFileSync(chunked, 'utf8'))
      if (!data.chunks.length) throw new Error("No chunks extracted. Resolve the page content or explicitly exclude this file from the ingestion scope.")
      if (!document.metadata.url) throw new Error("Unresolved generated route URL. Resolve this route before ingestion.")
      for (const c of data.chunks) {
        if (pointIds.has(c.id)) throw new Error('Duplicate point ID across documents: ' + c.id)
      }
      for (const c of data.chunks) pointIds.add(c.id)
      manifest.documents.push({
        document_id: document.id, source_file: file, source_hash: document.source.hash,
        url: document.metadata.url, dependencies: document.source.dependencies, assets: document.source.assets,
        warnings: [...document.source.extraction_warnings, ...(data.chunks.length ? [] : ['No chunks extracted; review before any deletion.'])],
        chunk_file: path.relative(output, chunked),
        chunks: data.chunks.map(c => ({ id: c.id, chunk_key: c.chunk_key, content_hash: c.content_hash })),
      })
    } catch (error) {
      manifest.failures.push({ source_file: file, error: error.message })
    }
  }
  let next = 0
  await Promise.all(Array.from({ length: 4 }, async () => { while (next < orderedFiles.length) await processFile(orderedFiles[next++]) }))
  // One Vue catch-all publishes hundreds of concrete endpoint routes.
  if (!selected && fs.existsSync(path.join(root, 'src/data/endpoints/index.ts'))) {
    let generatedEntries = []
    try { generatedEntries = generatedApiDocs(root, commit) } catch (error) { manifest.failures.push({source_file:'src/data/endpoints/index.ts',error:error.message}) }
    for (const generated of generatedEntries) {
      try {
        const { doc, chunks } = generated.build()
        if (!chunks.length) throw new Error('Generated API endpoint has no chunks')
        for (const c of chunks) { if (pointIds.has(c.id)) throw new Error('Duplicate generated point ID: ' + c.id) }
        const parsed = path.join(output, 'parsed-output', doc.id + '.json')
        const chunked = path.join(output, 'chunk-output', doc.id + '.chunks.json')
        fs.mkdirSync(path.dirname(parsed), { recursive: true }); fs.mkdirSync(path.dirname(chunked), { recursive: true })
        fs.writeFileSync(parsed, JSON.stringify(doc, null, 2) + '\n')
        fs.writeFileSync(chunked, JSON.stringify({ document_id:doc.id, chunk_count:chunks.length, chunks }, null, 2) + '\n')
        for (const c of chunks) pointIds.add(c.id)
        manifest.documents.push({document_id:doc.id,source_file:doc.source.file,source_hash:doc.source.hash,url:doc.metadata.url,dependencies:doc.source.dependencies,assets:doc.source.assets,warnings:[],chunk_file:path.relative(output,chunked),chunks:chunks.map(c=>({id:c.id,chunk_key:c.chunk_key,content_hash:c.content_hash}))})
      } catch (error) { manifest.failures.push({ document_id:generated.id, source_file:'src/pages/tech/api-specs/[...slug].vue', error:error.message }) }
    }
  }
  if (git('rev-parse', 'HEAD') !== commit || git('status', '--porcelain', '--untracked-files=all')) manifest.failures.push({ error: 'Source checkout changed during preparation.' })
  manifest.documents.sort((a,b) => a.document_id.localeCompare(b.document_id))
  manifest.failures.sort((a,b) => (a.document_id || a.source_file || '').localeCompare(b.document_id || b.source_file || ''))
  manifest.reused_documents = reused
  manifest.status = manifest.failures.length ? 'failed' : 'complete'
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`${manifest.status}: ${manifest.documents.length} documents, ${manifest.failures.length} failures. ${output}`)
  if (manifest.failures.length) process.exitCode = 1
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1 })
