const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { exclusionReason } = require('../src/scripts/ingestion-policy')

test('policy excludes exact restricted segments and prereleases, preserving stable pages', () => {
  for (const part of ['_dev', '_shared', 'internal', 'biopay', 'draft', 'v2.2-rc2', 'v3.0-beta.1']) {
    assert.ok(exclusionReason(`src/pages/tech/${part}/overview.vue`), part)
  }
  for (const route of ['tech/v2.1/overview', 'tech/internal-controls', 'tech/trust-framework']) {
    assert.equal(exclusionReason(route), null)
  }
  assert.ok(exclusionReason('tech/api-specs/endpoint', 'v2.2-rc2'))
})

test('preparation excludes authored, selected and generated drafts before extraction and reuse', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nebras-policy-'))
  try {
    const root = path.join(tmp, 'source')
    const write = (file, text) => { const p = path.join(root, file); fs.mkdirSync(path.dirname(p), {recursive:true}); fs.writeFileSync(p, text) }
    write('src/pages/tech/stable.vue', '<template><h1>Stable</h1><p>Public content.</p></template>')
    for (const dir of ['v2.2-rc2', 'internal', '_dev', 'biopay']) {
      write(`src/pages/tech/${dir}/example.vue`, '<template><h1>Excluded</h1><p>Should not be indexed.</p></template>')
    }
    write('src/pages/tech/api-specs/[...slug].vue', '<template><div /></template>')
    // Missing specs deliberately prove excluded generated routes never invoke build().
    write('src/data/endpoints/index.ts', `export const allEndpoints = [
      {route:'tech/api-specs/v2.2-rc2/example', version:'v2.2-rc2', redoc:{spec:'/missing.yaml'}},
      {route:'tech/api-specs/other', version:'v3.0-beta1', redoc:{spec:'/missing.yaml'}},
      {route:'tech/biopay/example', version:'v2.1', redoc:{spec:'/missing.yaml'}}
    ]; export function endpointUrl(e) { return '/' + e.route; }`)
    const git = (...a) => execFileSync('git', ['-C', root, ...a], {stdio:'pipe'})
    git('init'); git('add', '.'); git('-c','user.name=Test','-c','user.email=test@example.com','commit','-m','fixture')
    const run = (name, args=[]) => {
      const out=path.join(tmp,name)
      execFileSync(process.execPath, [path.resolve('src/scripts/prepare.js'),'--source-root',root,'--output',out,...args],{stdio:'pipe'})
      return JSON.parse(fs.readFileSync(path.join(out,'manifest.json')))
    }
    const first=run('first')
    assert.equal(first.status,'complete')
    assert.equal(first.documents.length,1)
    assert.equal(first.documents[0].document_id,'tech/stable')
    assert.equal(first.excluded.filter(e=>e.document_id).length,3)
    assert.equal(first.policy_version,'public-docs-2')
    const reused=run('reused',['--previous',path.join(tmp,'first/manifest.json')])
    assert.equal(reused.documents.length,1)
    assert.equal(reused.reused_documents,1)
    const selected=path.join(tmp,'selected.json')
    fs.writeFileSync(selected,JSON.stringify(['src/pages/tech/internal/example.vue','src/pages/tech/stable.vue']))
    assert.equal(run('selected',['--files',selected]).documents.length,1)
  } finally {fs.rmSync(tmp,{recursive:true,force:true})}
})
