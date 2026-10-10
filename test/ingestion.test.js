const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')
const { finalizeChunks, pageUrl } = require('../src/scripts/chunk-contract')
const scripts = path.resolve(__dirname, '../src/scripts')
const document = { id: 'tech/example', source: { repo: 'community-standards' }, metadata: {} }
const chunk = (section, text = section) => ({ document_id: document.id, type: 'section', text, metadata: { section } })

test('unrelated insertions preserve IDs; edits change hashes, not IDs; repo scopes IDs', () => {
  const old = finalizeChunks(document, [chunk('A'), chunk('B')])
  const next = finalizeChunks(document, [chunk('New'), chunk('A'), chunk('B', 'Edited')])
  assert.equal(old[0].id, next[1].id)
  assert.equal(old[0].content_hash, next[1].content_hash)
  assert.equal(old[1].id, next[2].id)
  assert.notEqual(old[1].content_hash, next[2].content_hash)
  assert.match(old[0].id, /^[\da-f]{8}-[\da-f]{4}-5[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/)
  assert.notEqual(old[0].id, finalizeChunks({ ...document, source: { repo: 'other/repo' } }, [chunk('A')])[0].id)
  assert.equal(new Set(finalizeChunks(document, [chunk('A'), chunk('A')]).map(c => c.id)).size, 2)
})

test('URLs do not invent dynamic routes; navigation destinations are distinct from citations', () => {
  assert.equal(pageUrl('tech/[...slug]'), null)
  assert.equal(pageUrl('tech/_shared/example'), null)
  const [c] = finalizeChunks(document, [{ type: 'navigation', text: 'Go', metadata: { url: '/other' } }])
  assert.equal(c.metadata.url, 'https://nebras-open-finance.com/tech/example')
  assert.equal(c.metadata.navigation_url, '/other')
})

test('actual parser/chunker runner: manifests, targeted runs, failures and stable chunks', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebras-test-'))
  try {
    const root = path.join(tmp, 'source')
    fs.mkdirSync(path.join(root, 'src/pages/tech/v2.1'), { recursive: true })
    const relative = 'src/pages/tech/v2.1/example.vue'
    const file = path.join(root, relative)
    fs.writeFileSync(file, '<template><h1>Example</h1><p>Hello</p><h2 id="a">A</h2><p>Alpha</p><h2 id="b">B</h2><p>Beta</p></template>')
    const git = (...args) => execFileSync('git', ['-C', root, ...args], { stdio: 'pipe' })
    git('init'); git('add', '.')
    const commit = () => git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-am', 'fixture')
    commit()
    const run = (name, extra = []) => {
      const out = path.join(tmp, name)
      const result = spawnSync(process.execPath, [path.join(scripts, 'prepare.js'), '--source-root', root, '--output', out, ...extra], { encoding: 'utf8' })
      return { out, result, manifest: fs.existsSync(path.join(out, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'))) : null }
    }
    const first = run('first')
    assert.equal(first.result.status, 0, first.result.stderr)
    const doc = first.manifest.documents[0]
    assert.equal(doc.chunks.length, 3)
    const data = JSON.parse(fs.readFileSync(path.join(first.out, doc.chunk_file)))
    assert.equal(data.chunks[0].metadata.doc_version, 'v2.1')
    assert.equal(data.chunks[0].metadata.parser_version, '3')
    const reused = run('reused', ['--previous', path.join(first.out, 'manifest.json')])
    assert.equal(reused.result.status, 0, reused.result.stderr)
    assert.equal(reused.manifest.reused_documents, 1)
    assert.deepEqual(reused.manifest.documents[0].chunks, doc.chunks)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<h2 id="a">', '<h2 id="new">New</h2><p>Inserted</p><h2 id="a">'))
    assert.notEqual(run('dirty').result.status, 0)
    commit()
    const updated = run('updated', ['--previous', path.join(first.out, 'manifest.json')])
    assert.equal(updated.result.status, 0, updated.result.stderr)
    assert.equal(updated.manifest.reused_documents, 0)
    assert.equal(updated.manifest.documents[0].chunks.length, 4)
    const list = path.join(tmp, 'files.json'); fs.writeFileSync(list, JSON.stringify([relative]))
    const second = run('second', ['--files', list])
    assert.equal(second.result.status, 0, second.result.stderr)
    const after = second.manifest.documents[0].chunks
    for (const c of doc.chunks) assert.ok(after.some(n => n.id === c.id && n.content_hash === c.content_hash))
    assert.notEqual(run('second').result.status, 0)
    fs.writeFileSync(list, JSON.stringify(['src/pages/missing.vue']))
    const failed = run('failed', ['--files', list])
    assert.equal(failed.result.status, 1)
    assert.equal(failed.manifest.status, 'failed')
    assert.equal(failed.manifest.documents.length, 0)
    assert.equal(failed.manifest.failures.length, 1)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('RedocWrapper extracts endpoint definitions and refuses missing/dynamic assets', () => {
  const { extractOpenApi } = require('../src/scripts/openapi-extractor')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebras-openapi-'))
  try {
    fs.mkdirSync(path.join(tmp, 'public/openapi'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'public/openapi/trust-framework.yaml'), `openapi: 3.0.3
info: {title: Trust Framework, version: '1'}
paths:
  /organisations/export/open-data:
    get:
      summary: Participants
      responses:
        '200':
          description: OK
          content:
            application/json:
              schema: {$ref: '#/components/schemas/Participant'}
  /unrelated:
    get: {summary: Unrelated}
components:
  schemas:
    Participant:
      type: object
      properties:
        name: {type: string, description: Participant name}
`)
    const template = `<EndpointPage title="Participants"><RedocWrapper spec="/openapi/trust-framework.yaml" filterPath="/organisations/export/open-data" displayPath="/participants" :overrideServers="[{ url: 'https://data.directory.openfinance.ae' }]" :hideSecurity="true" /></EndpointPage>`
    const extracted = extractOpenApi(template, tmp)
    assert.equal(extracted.sections.length, 2)
    const text = JSON.stringify(extracted.sections)
    assert.match(text, /Participant name/)
    assert.match(text, /data.directory.openfinance.ae/)
    assert.doesNotMatch(text, /Unrelated/)
    assert.deepEqual(extracted.dependencies, ['public/openapi/trust-framework.yaml'])
    assert.match(extracted.assets[0].hash, /^[a-f0-9]{64}$/)
    assert.throws(() => extractOpenApi(template.replace('trust-framework.yaml', 'missing.yaml'), tmp))
    assert.throws(() => extractOpenApi(`<RedocWrapper :spec="specUrl" />`, tmp), /Unresolved static identifier/)
    assert.throws(() => extractOpenApi(template.replace('/organisations/export/open-data', '/missing'), tmp), /selection does not exist/)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})

test('requirements and field-map data are extracted with dependency hashes', () => {
  const {extractStructured}=require('../src/scripts/structured-extractor')
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nebras-data-'))
  try {
    fs.mkdirSync(path.join(tmp,'src/data/requirements'),{recursive:true})
    fs.writeFileSync(path.join(tmp,'src/data/requirements/example.ts'),`export const data={title:'Rules',lede:'<p>Intro</p>',sections:[{id:'rule',title:'Validation',rules:[{field:'<code>Amount</code>',rule:'Must be positive',validatedBy:'LFI'}],subsections:[{heading:'Details',blocks:[{kind:'prose',html:'Keep <strong>evidence</strong>'}]}]}]}`)
    const descriptor={scriptSetup:{content:`import { data } from '@/data/requirements/example'`},template:{content:'<p>{{ data.lede }}</p>'}}
    const extracted=extractStructured(descriptor,tmp,'v2.1')
    assert.equal(extracted.content.sections.length,2)
    assert.match(JSON.stringify(extracted.content),/Must be positive/)
    assert.equal(extracted.content.sections[0].blocks[0].rows[0][0],'Amount')
    assert.equal(extracted.dependencies[0],'src/data/requirements/example.ts')
    fs.writeFileSync(path.join(tmp,'src/data/versions.ts'),`export const FIELD_MAP_DIR={'v2.2-rc2':'field-map/v2.1'}`)
    fs.mkdirSync(path.join(tmp,'public/api/field-map/v2.1/resources'),{recursive:true})
    fs.writeFileSync(path.join(tmp,'public/api/field-map/v2.1/resources/accounts.json'),JSON.stringify({version:'v2.1',records:[{ozonePath:'data.amount',standardsPath:'Data.Amount',permissions:['ReadBalances'],verified:'not-observed',reviewNeeded:true}]}))
    const field=extractStructured({template:{content:'<FieldMapEndpointPage slug="accounts" version="v2.2-rc2" title="Fields" />'}},tmp,'v2.2-rc2')
    assert.match(JSON.stringify(field.content),/ReadBalances/)
    assert.match(JSON.stringify(field.content),/not-observed/)
    assert.equal(field.assets.length,2)
  } finally {fs.rmSync(tmp,{recursive:true,force:true})}
})

test('long schema chunks are bounded, deterministic and unique across duplicate headings',()=>{
 const long={type:'section',text:'Title\n\n'+('schema field description\n'.repeat(1000)),metadata:{section:'Schema'}}
 const first=finalizeChunks(document,[long,long])
 assert.ok(first.length>2)
 assert.ok(first.every(c=>c.text.length<=6000))
 assert.equal(new Set(first.map(c=>c.id)).size,first.length)
 assert.deepEqual(first.map(c=>c.id),finalizeChunks(document,[long,long]).map(c=>c.id))
})
