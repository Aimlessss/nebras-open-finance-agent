#!/usr/bin/env node
// Run only under the shared GitHub Actions concurrency group.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const {execFileSync} = require('node:child_process')
const {loadPair, planChanges, fingerprint, runIncremental} = require('./incremental')
const {exclusionReason} = require('./ingestion-policy')
const ORIGINAL = 'baselines/baseline-ts5.tar.gz'
function validatePlan(previous, next, expectedDeletes) {
  const plan = planChanges(previous.chunks, next.chunks)
  if (!/^\d+$/.test(String(expectedDeletes)) || plan.delete.length !== Number(expectedDeletes)) throw new Error('Deletion count differs from the explicitly reviewed count.')
  const deleted = new Set(plan.delete)
  const report = previous.chunks.filter(c => deleted.has(c.id)).map(c => ({id:c.id, document_id:c.document_id, reason:exclusionReason(c.document_id,c.metadata.doc_version) || 'Source removed or chunk structure changed'}))
  return {plan, report}
}
async function main() {
  const env = process.env
  for (const key of ['STATE_BUCKET','PREVIEW_ID','GEMINI_API_KEY','QDRANT_URL','QDRANT_API_KEY','EMBEDDING_MODEL','EMBEDDING_DIMENSIONS']) if (!env[key]) throw new Error(`Set ${key}.`)
  if (!/^\d+-\d+$/.test(env.PREVIEW_ID)) throw new Error('PREVIEW_ID must be RUN_ID-ATTEMPT, copied from the preview.')
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'execute-s3-'))
  const aws = args => execFileSync('aws', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']})
  const uri = key => `s3://${env.STATE_BUCKET}/${key}`
  const controlKey = 'state/current.json'
  const listing = JSON.parse(aws(['s3api','list-objects-v2','--bucket',env.STATE_BUCKET,'--prefix',controlKey,'--output','json']))
  let control = {baseline:ORIGINAL, pending:null}
  if ((listing.Contents || []).some(o => o.Key === controlKey)) control = JSON.parse(aws(['s3','cp',uri(controlKey),'-','--only-show-errors']))
  if (!control.baseline || typeof control.baseline !== 'string') throw new Error('Invalid baseline pointer.')
  const nextKey = `previews/${env.PREVIEW_ID}/run.tar.gz`
  if (control.pending && control.pending.next !== nextKey) throw new Error('An update is pending. Resume its original preview: '+control.pending.preview)
  if (control.baseline === nextKey && !control.pending) { console.log('This preview is already applied.'); return }
  function restore(key, name) {
    const dir = path.join(root,name); fs.mkdirSync(dir)
    const archive = path.join(root,name+'.tar.gz')
    aws(['s3','cp',uri(key),archive,'--only-show-errors'])
    execFileSync('tar',['-xzf',archive,'-C',dir])
    return path.join(dir,'manifest.json')
  }
  const previousFile = restore(control.baseline,'previous'), nextFile = restore(nextKey,'next')
  const {previous,next} = loadPair(previousFile,nextFile)
  const baselineHash = fs.readFileSync(path.join(root,'next','baseline-fingerprint.txt'),'utf8').trim()
  if (baselineHash !== fingerprint(previous.manifest)) throw new Error('Preview used a different baseline. Generate a fresh preview.')
  const {plan,report} = validatePlan(previous,next,env.EXPECTED_DELETES)
  const reportFile = path.join(root,'deletions.json'); fs.writeFileSync(reportFile,JSON.stringify(report,null,2))
  aws(['s3','cp',reportFile,uri(`previews/${env.PREVIEW_ID}/deletions.json`),'--only-show-errors'])
  console.log(JSON.stringify(Object.fromEntries(Object.entries(plan).map(([k,v])=>[k,v.length]))))
  const stateDir = path.join(root,'state'); fs.mkdirSync(stateDir)
  if (control.pending?.checkpoint) fs.writeFileSync(path.join(stateDir,'incremental-state.json'),JSON.stringify(control.pending.checkpoint))
  function save() {
    const file = path.join(root,'control.json'); fs.writeFileSync(file,JSON.stringify(control,null,2))
    aws(['s3','cp',file,uri(controlKey),'--only-show-errors'])
  }
  if (!control.pending) { control.pending = {preview:env.PREVIEW_ID,next:nextKey,checkpoint:null}; save() }
  await runIncremental({previousFile,nextFile,stateDir,execute:true,
    model:env.EMBEDDING_MODEL,dimensions:Number(env.EMBEDDING_DIMENSIONS),
    taskType:env.EMBEDDING_TASK_TYPE || '',collection:'nebras_community_docs_v2',
    qdrantUrl:env.QDRANT_URL,qdrantKey:env.QDRANT_API_KEY,geminiKey:env.GEMINI_API_KEY,
    onCheckpoint:async checkpoint => { control.pending.checkpoint=checkpoint; save() }
  })
  control = {baseline:nextKey,pending:null,completed_at:new Date().toISOString()}; save()
  console.log('Qdrant verified. S3 current baseline advanced to '+nextKey)
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode=1 })
module.exports = {validatePlan}
