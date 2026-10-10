const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os')
const {finalizeChunks}=require('../src/scripts/chunk-contract')
const {runUpload,loadRun}=require('../src/scripts/embed-upload')
function fixture(tmp) {
  const doc={id:'tech/example',source:{repo:'community-standards',commit:'abc'},metadata:{url:'https://nebras-open-finance.com/tech/example'}}
  const chunks=finalizeChunks(doc,[{type:'intro',document_id:doc.id,text:'Example',metadata:{source_file:'src/pages/tech/example.vue'}}])
  fs.writeFileSync(path.join(tmp,'chunks.json'),JSON.stringify({document_id:doc.id,chunk_count:1,chunks}))
  const manifest={status:'complete',source_commit:'abc',failures:[],documents:[{document_id:doc.id,chunk_file:'chunks.json',chunks:chunks.map(c=>({id:c.id,chunk_key:c.chunk_key,content_hash:c.content_hash}))}]}
  const file=path.join(tmp,'manifest.json');fs.writeFileSync(file,JSON.stringify(manifest));return file
}
test('uploader validates dry run, retries upload using cached vectors and preserves payload',async()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'nebras-upload-'))
 try {
  const manifestFile=fixture(tmp);let embeddings=0,failUpload=true,exists=false,uploaded
  const fetcher=async(url,options)=>{
   const body=options.body?JSON.parse(options.body):null
   if(url.includes('googleapis')) {embeddings++;return {ok:true,json:async()=>({embedding:{values:[3,4]}})}}
   if(options.method==='GET')return exists?{ok:true,json:async()=>({result:{config:{params:{vectors:{size:2,distance:'Cosine'}}}}})}:{ok:false,status:404}
   if(url.endsWith('/collections/test'))exists=true
   if(url.includes('/points?')){if(failUpload)throw new Error('connection lost');uploaded=body.points[0]}
   return {ok:true,json:async()=>url.endsWith('/count')?{result:{count:1}}:{result:{status:'completed'}}}
  }
  const options={manifestFile,model:'gemini-embedding-001',dimensions:2,collection:'test',qdrantUrl:'https://qdrant.example',geminiKey:'test',fetcher}
  await runUpload({...options,fetcher:()=>{throw new Error('dry run made request')}})
  await assert.rejects(runUpload({...options,execute:true}),/connection lost/)
  assert.equal(embeddings,1);assert.equal(fs.existsSync(path.join(tmp,'upload.lock')),false)
  failUpload=false;await runUpload({...options,execute:true})
  assert.equal(embeddings,1)
  assert.equal(uploaded.payload.document_id,'tech/example')
  assert.equal(uploaded.payload.metadata.source_file,'src/pages/tech/example.vue')
  assert.deepEqual(uploaded.vector,[0.6,0.8])
  const data=JSON.parse(fs.readFileSync(path.join(tmp,'chunks.json')));data.chunks[0].text='Changed';fs.writeFileSync(path.join(tmp,'chunks.json'),JSON.stringify(data))
  assert.throws(()=>loadRun(manifestFile),/Invalid chunk/)
 } finally {fs.rmSync(tmp,{recursive:true,force:true})}
})
