#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const { hashText, pointId } = require('./chunk-contract')

function loadRun(manifestFile) {
  const root = fs.realpathSync(path.dirname(path.resolve(manifestFile)))
  const manifest = JSON.parse(fs.readFileSync(manifestFile,'utf8'))
  if (manifest.status !== 'complete' || manifest.failures?.length || !manifest.documents?.length) throw new Error('Embedding requires a complete, nonempty manifest with no failures.')
  const chunks=[], ids=new Set()
  for(const doc of manifest.documents) {
    const file=fs.realpathSync(path.resolve(root,doc.chunk_file))
    if(!file.startsWith(root+path.sep))throw new Error('Chunk file escapes run directory.')
    const data=JSON.parse(fs.readFileSync(file,'utf8'))
    if(data.document_id!==doc.document_id || !data.chunks?.length || data.chunk_count!==data.chunks.length || data.chunks.length!==doc.chunks.length)throw new Error('Manifest/chunk mismatch: '+doc.document_id)
    for(let i=0;i<data.chunks.length;i++) {
      const c=data.chunks[i], expected=doc.chunks[i]
      if(c.id!==expected.id || c.chunk_key!==expected.chunk_key || c.id!==pointId(c.metadata?.source_repo,c.document_id,c.chunk_key) || c.content_hash!==expected.content_hash || c.document_id!==doc.document_id || c.schema_version!==2 || !c.text || hashText(c.text)!==c.content_hash || !c.metadata?.url || c.metadata.source_commit!==manifest.source_commit)throw new Error('Invalid chunk: '+c.id)
      if(ids.has(c.id))throw new Error('Duplicate chunk: '+c.id)
      ids.add(c.id);chunks.push(c)
    }
  }
  return {manifest,chunks,root}
}
async function jsonRequest(url,method,headers,body,fetcher=fetch) {
  for(let attempt=0;attempt<5;attempt++) {
    const response=await fetcher(url,{method,headers,body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)})
    if(response.ok)return response.json()
    if(response.status===404)return {notFound:true}
    if([429,500,502,503,504].includes(response.status)&&attempt<4) { await new Promise(r=>setTimeout(r,Math.min(1000*2**attempt,16000)));continue }
    // Do not echo response bodies, URLs with credentials, or provider request text.
    throw new Error(`HTTP ${response.status} from ${new URL(url).hostname}`)
  }
}
async function runUpload({manifestFile,model,dimensions,collection,qdrantUrl,geminiKey,qdrantKey,execute=false,taskType='',fetcher=fetch}) {
  const {manifest,chunks,root}=loadRun(manifestFile)
  if(!model || !Number.isInteger(dimensions) || dimensions<1 || !/^[a-zA-Z0-9_-]+$/.test(collection||''))throw new Error('Set EMBEDDING_MODEL, EMBEDDING_DIMENSIONS and QDRANT_COLLECTION.')
  model=model.replace(/^models\//,'')
  const config={model,dimensions,task_type:taskType,normalization:'l2',collection,qdrant_url:qdrantUrl||null}
  const signature=hashText(JSON.stringify({manifest,config}))
  console.log(`Validated ${manifest.documents.length} documents, ${chunks.length} chunks. Model ${model}, ${dimensions} dimensions. ${execute?'Executing':'Dry run'}.`)
  if(!execute)return {chunks:chunks.length,documents:manifest.documents.length}
  if(!geminiKey || !qdrantUrl)throw new Error('Set GEMINI_API_KEY and QDRANT_URL before --execute.')
  const base=new URL(qdrantUrl)
  if(base.username||base.password||base.search||base.hash)throw new Error('QDRANT_URL must not contain embedded credentials or query parameters.')
  const collectionPath=`${base.href.replace(/\/$/,'')}/collections/${encodeURIComponent(collection)}`
  const headers={'Content-Type':'application/json',...(qdrantKey?{'api-key':qdrantKey}:{})}
  const stateFile=path.join(root,'upload-state.json'),lock=path.join(root,'upload.lock')
  const fd=fs.openSync(lock,'wx')
  try {
    let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):{signature,config,status:'running'}
    if(state.signature!==signature)throw new Error('Resume state belongs to a different run/model/configuration. Use a fresh run directory.')
    const existing=await jsonRequest(collectionPath,'GET',headers,undefined,fetcher)
    if(!existing.notFound) {
      if(!fs.existsSync(stateFile))throw new Error('Collection already exists without a matching local resume state. Choose a new collection.')
      const v=existing.result?.config?.params?.vectors
      if(v?.size!==dimensions || v?.distance!=='Cosine')throw new Error('Collection vector configuration does not match this run.')
    } else {
      if(state.status==='complete')throw new Error('Previously completed collection is missing. Use a fresh collection/run.')
      // Persist state before creating collection so a retry can safely resume.
      fs.writeFileSync(stateFile,JSON.stringify(state,null,2))
      await jsonRequest(collectionPath,'PUT',headers,{vectors:{size:dimensions,distance:'Cosine'}},fetcher)
    }
    for(const field of ['document_id','metadata.source_file','metadata.source_repo'])await jsonRequest(collectionPath+'/index?wait=true','PUT',headers,{field_name:field,field_schema:'keyword'},fetcher)
    const cacheDir=path.join(root,'embedding-cache',hashText(JSON.stringify(config)))
    fs.mkdirSync(cacheDir,{recursive:true})
    for(let start=0;start<chunks.length;start+=32) {
      const points=[]
      for(const c of chunks.slice(start,start+32)) {
        const cache=path.join(cacheDir,c.content_hash+'.json')
        let vector
        if(fs.existsSync(cache))vector=JSON.parse(fs.readFileSync(cache,'utf8'))
        else {
          const result=await jsonRequest(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`,'POST',{'Content-Type':'application/json','x-goog-api-key':geminiKey},{content:{parts:[{text:c.text}]},outputDimensionality:dimensions,...(taskType?{taskType}:{})},fetcher)
          vector=result.embedding?.values
          if(!Array.isArray(vector)||vector.length!==dimensions||vector.some(v=>!Number.isFinite(v)))throw new Error('Invalid embedding dimensions or values.')
          const norm=Math.sqrt(vector.reduce((sum,v)=>sum+v*v,0));if(!norm)throw new Error('Zero embedding vector.')
          vector=vector.map(v=>v/norm)
          fs.writeFileSync(cache+'.tmp',JSON.stringify(vector));fs.renameSync(cache+'.tmp',cache)
        }
        if(!Array.isArray(vector)||vector.length!==dimensions||vector.some(v=>!Number.isFinite(v)))throw new Error('Invalid cached embedding.')
        points.push({id:c.id,vector,payload:{...c,embedding_model:model,embedding_dimensions:dimensions,embedding_task_type:taskType,embedding_normalization:'l2'}})
      }
      await jsonRequest(collectionPath+'/points?wait=true','PUT',headers,{points},fetcher)
      state={...state,status:'running',uploaded:Math.min(start+32,chunks.length)}
      fs.writeFileSync(stateFile+'.tmp',JSON.stringify(state,null,2));fs.renameSync(stateFile+'.tmp',stateFile)
      console.log(`Uploaded ${state.uploaded}/${chunks.length}`)
    }
    const counted=await jsonRequest(collectionPath+'/points/count','POST',headers,{exact:true},fetcher)
    if(counted.result?.count!==chunks.length)throw new Error('Final Qdrant point count does not match manifest.')
    state.status='complete';fs.writeFileSync(stateFile,JSON.stringify(state,null,2));return state
  } finally {fs.closeSync(fd);fs.unlinkSync(lock)}
}
if(require.main===module) {
  const args=process.argv.slice(2),index=args.indexOf('--manifest')
  runUpload({manifestFile:index>=0?args[index+1]:null,model:process.env.EMBEDDING_MODEL,dimensions:Number(process.env.EMBEDDING_DIMENSIONS),collection:process.env.QDRANT_COLLECTION,qdrantUrl:process.env.QDRANT_URL,geminiKey:process.env.GEMINI_API_KEY,qdrantKey:process.env.QDRANT_API_KEY,taskType:process.env.EMBEDDING_TASK_TYPE||'',execute:args.includes('--execute')}).catch(e=>{console.error(e.message);process.exitCode=1})
}
module.exports={loadRun,runUpload,jsonRequest}
