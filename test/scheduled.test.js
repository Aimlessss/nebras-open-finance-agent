const {test}=require('node:test')
const assert=require('node:assert/strict')
const {pendingPreview}=require('../src/scripts/resume-s3')
test('scheduled recovery pins the existing pending preview, including before its first checkpoint',()=>{
 assert.equal(pendingPreview({baseline:'baselines/original.tar.gz',pending:null}),null)
 const control={baseline:'baselines/original.tar.gz',pending:{preview:'123-1',next:'previews/123-1/run.tar.gz',checkpoint:null}}
 assert.equal(pendingPreview(control),'123-1')
 assert.throws(()=>pendingPreview({...control,pending:{...control.pending,next:'previews/456-1/run.tar.gz'}}),/Invalid pending/)
 assert.throws(()=>pendingPreview({...control,baseline:null}),/Invalid pending/)
})
