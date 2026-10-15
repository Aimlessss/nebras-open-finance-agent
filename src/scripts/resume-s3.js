#!/usr/bin/env node
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
const {execFileSync}=require('node:child_process')
const {loadPair,planChanges}=require('./incremental')
function pendingPreview(control) {
  if (!control.pending) return null
  const p=control.pending
  if (!/^\d+-\d+$/.test(p.preview) || p.next!==`previews/${p.preview}/run.tar.gz` || !control.baseline) throw Error('Invalid pending update; refusing to prepare new content.')
  return p.preview
}
function main() {
  const env=process.env
  if(!env.STATE_BUCKET)throw Error('Set STATE_BUCKET.')
  const aws=args=>execFileSync('aws',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']})
  if(aws(['sts','get-caller-identity','--query','Account','--output','text']).trim()!=='916861645417')throw Error('Unexpected AWS account.')
  const key='state/current.json', uri=k=>`s3://${env.STATE_BUCKET}/${k}`
  const listing=JSON.parse(aws(['s3api','list-objects-v2','--bucket',env.STATE_BUCKET,'--prefix',key,'--output','json']))
  let resumed=false
  if((listing.Contents||[]).some(o=>o.Key===key)) {
    const control=JSON.parse(aws(['s3','cp',uri(key),'-','--only-show-errors']))
    const preview=pendingPreview(control)
    if(preview) {
      console.log('Resuming pending preview '+preview+' before any new source checkout.')
      const root=fs.mkdtempSync(path.join(os.tmpdir(),'resume-s3-'))
      function restore(archiveKey,name) {
        const dir=path.join(root,name);fs.mkdirSync(dir)
        const file=path.join(root,name+'.tar.gz')
        aws(['s3','cp',uri(archiveKey),file,'--only-show-errors'])
        execFileSync('tar',['-xzf',file,'-C',dir])
        return path.join(dir,'manifest.json')
      }
      const {previous,next}=loadPair(restore(control.baseline,'previous'),restore(control.pending.next,'next'))
      const count=planChanges(previous.chunks,next.chunks).delete.length
      execFileSync(process.execPath,[path.join(__dirname,'execute-s3.js')],{stdio:'inherit',env:{...env,PREVIEW_ID:preview,EXPECTED_DELETES:String(count)}})
      resumed=true
      if(env.GITHUB_STEP_SUMMARY)fs.appendFileSync(env.GITHUB_STEP_SUMMARY,`Resumed and verified pending preview ${preview}. New source changes will be checked on the next run.\n`)
    }
  }
  if(env.GITHUB_OUTPUT)fs.appendFileSync(env.GITHUB_OUTPUT,`resumed=${resumed}\n`)
}
if(require.main===module)try{main()}catch(e){console.error(e.message);process.exitCode=1}
module.exports={pendingPreview}
