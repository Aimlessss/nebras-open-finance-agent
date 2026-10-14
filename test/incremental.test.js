const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),os=require('node:os'),path=require('node:path')
const {finalizeChunks,hashText}=require('../src/scripts/chunk-contract')
const {planChanges,runIncremental,loadPair}=require('../src/scripts/incremental')
const {reusableDocument}=require('../src/scripts/reuse-document')
function fixture(root,name,commit,sections) {
 const dir=path.join(root,name);fs.mkdirSync(dir)
 const doc={id:'tech/example',source:{repo:'community-standards',commit},metadata:{url:'https://nebras-open-finance.com/tech/example'}}
 const chunks=finalizeChunks(doc,sections.map(([anchor,text])=>({type:'section',document_id:doc.id,text,metadata:{anchor,source_file:'src/pages/tech/example.vue'}})))
 fs.writeFileSync(path.join(dir,'chunks.json'),JSON.stringify({document_id:doc.id,chunk_count:chunks.length,chunks}))
 const manifest={mode:'full',scope:'public-docs',source_repo:'Nebras-Open-Finance/community-standards',status:'complete',source_commit:commit,failures:[],documents:[{document_id:doc.id,chunk_file:'chunks.json',chunks:chunks.map(c=>({id:c.id,chunk_key:c.chunk_key,content_hash:c.content_hash}))}]}
 const file=path.join(dir,'manifest.json');fs.writeFileSync(file,JSON.stringify(manifest));return {file,chunks}
}
const payload=c=>({...c,embedding_model:'test-model',embedding_dimensions:2,embedding_task_type:'',embedding_normalization:'l2'})
test('plan handles additions, text edits, partial deletion, whole-document deletion, and metadata',()=>{
 const a={id:'a',content_hash:'one',metadata:{url:'a'}},b={id:'b',content_hash:'two'},c={id:'c',content_hash:'three'}
 assert.deepEqual(planChanges([a,b,c],[{...a,content_hash:'changed'},{...b,metadata:{url:'new'}},{id:'d',content_hash:'new'}]),{add:['d'],update:['a'],metadata:['b'],unchanged:[],delete:['c']})
 assert.deepEqual(planChanges([a,b],[]).delete,['a','b'])
 assert.deepEqual(planChanges([a],[{metadata:{url:'a'},content_hash:'one',id:'a'}]).unchanged,['a'])
})
test('incremental execution retains unchanged vectors, resumes cached embeddings, verifies deletion and rejects drift',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'incremental-'))
 try {
  const before=fixture(tmp,'before','abc',[['keep','Keep'],['edit','Old'],['delete','Remove']])
  const after=fixture(tmp,'after','def',[['keep','Keep'],['edit','Updated'],['add','New']])
  const remote=new Map(before.chunks.map(c=>[c.id,{id:c.id,payload:payload(c),vector:[1,0]}]))
  let embeddings=0,fail=true,deleted=false
  const fetcher=async(url,options)=>{
   const body=options.body?JSON.parse(options.body):null
   if(url.includes('googleapis')){embeddings++;return {ok:true,json:async()=>({embedding:{values:[3,4]}})}}
   if(options.method==='GET')return {ok:true,json:async()=>({result:{config:{params:{vectors:{size:2,distance:'Cosine'}}}}})}
   if(url.endsWith('/points'))return {ok:true,json:async()=>({result:body.ids.filter(id=>remote.has(id)).map(id=>remote.get(id))})}
   if(url.includes('/points/batch?'))for(const op of body.operations)for(const id of op.overwrite_payload.points)remote.get(id).payload=op.overwrite_payload.payload
   else if(url.includes('/points/delete?')){assert.equal(remote.get(after.chunks[1].id).payload.text,'Updated');deleted=true;for(const id of body.points)remote.delete(id)}
   else if(url.includes('/points?')){for(const p of body.points)remote.set(p.id,p);if(fail){fail=false;throw new Error('connection lost')}}
   else throw new Error('Unexpected request '+url)
   return {ok:true,json:async()=>({result:{status:'completed'}})}
  }
  const options={previousFile:before.file,nextFile:after.file,stateDir:path.join(tmp,'state'),model:'test-model',dimensions:2,collection:'test',qdrantUrl:'https://qdrant.example',geminiKey:'test',fetcher}
  const dry=await runIncremental({...options,fetcher:()=>{throw new Error('offline dry run made a request')}})
  assert.deepEqual(dry.counts,{add:1,update:1,metadata:1,unchanged:0,delete:1})
  let durableCheckpoint
  options.onCheckpoint=async state=>{durableCheckpoint=JSON.parse(JSON.stringify(state))}
  await assert.rejects(runIncremental({...options,execute:true,onCheckpoint:async()=>{throw Error('S3 unavailable')}}),/S3 unavailable/)
  assert.equal(embeddings,0)
  assert.deepEqual([...remote.values()].map(p=>p.payload),before.chunks.map(payload))
  await assert.rejects(runIncremental({...options,execute:true}),/connection lost/)
  assert.equal(durableCheckpoint.status,'running')
  assert.equal(embeddings,2);assert.equal(deleted,false)
  assert.equal(JSON.parse(fs.readFileSync(path.join(options.stateDir,'incremental-state.json'))).status,'running')
  // Fresh runner: only the durable checkpoint survives, with no vector cache.
  options.stateDir=path.join(tmp,'fresh-runner');fs.mkdirSync(options.stateDir)
  fs.writeFileSync(path.join(options.stateDir,'incremental-state.json'),JSON.stringify(durableCheckpoint))
  await runIncremental({...options,execute:true})
  assert.equal(durableCheckpoint.status,'complete')
  assert.equal(embeddings,2);assert.equal(deleted,true);assert.equal(remote.size,3)
  assert.deepEqual(remote.get(before.chunks[0].id).vector,[1,0])
  assert.deepEqual(remote.get(after.chunks[1].id).vector,[0.6,0.8])
  assert.equal((await runIncremental({...options,execute:true})).status,'already-complete')
  const third=fixture(tmp,'third','ghi',[['keep','Keep'],['edit','Updated'],['add','Newer']])
  await assert.rejects(runIncremental({...options,nextFile:third.file,execute:true}),/Checkpoint mismatch/)
  remote.get(after.chunks[0].id).payload.embedding_model='other-model'
  await assert.rejects(runIncremental({...options,previousFile:after.file,nextFile:third.file,execute:true}),/payload drift/)
  const manifest=JSON.parse(fs.readFileSync(after.file));manifest.mode='selected';fs.writeFileSync(after.file,JSON.stringify(manifest))
  assert.throws(()=>loadPair(before.file,after.file),/FULL manifests/)
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
})
test('reuse detects source and shared dependency changes and refuses unresolved imports',()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'reuse-'))
 try {
  fs.writeFileSync(path.join(tmp,'page.vue'),'page');fs.writeFileSync(path.join(tmp,'shared.ts'),'data')
  const doc={source_file:'page.vue',source_hash:hashText('page'),dependencies:['shared.ts'],assets:[{file:'shared.ts',hash:hashText('data')}]}
  assert.equal(reusableDocument(doc,tmp),true)
  fs.writeFileSync(path.join(tmp,'shared.ts'),'changed');assert.equal(reusableDocument(doc,tmp),false)
  assert.equal(reusableDocument({...doc,dependencies:['@/unresolved']},tmp),false)
  fs.unlinkSync(path.join(tmp,'page.vue'));assert.equal(reusableDocument(doc,tmp),false)
 }finally{fs.rmSync(tmp,{recursive:true,force:true})}
})
