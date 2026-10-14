const {test}=require('node:test')
const assert=require('node:assert/strict')
const {validatePlan}=require('../src/scripts/execute-s3')
test('execution requires exact reviewed deletion count and reports excluded versus removed pages',()=>{
 const previous={chunks:[
  {id:'a',document_id:'tech/v2.2-rc2/example',metadata:{doc_version:'v2.2-rc2'}},
  {id:'b',document_id:'tech/stable',metadata:{doc_version:'v2.1'}}
 ]}
 const next={chunks:[]}
 for(const count of [undefined,'',1,'2.0','no']) assert.throws(()=>validatePlan(previous,next,count),/Deletion count/)
 const {report}=validatePlan(previous,next,'2')
 assert.equal(report[0].reason,'Draft or prerelease version')
 assert.equal(report[1].reason,'Source removed or chunk structure changed')
})
