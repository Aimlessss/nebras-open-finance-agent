#!/usr/bin/env node
const fs = require('node:fs')
const path = require('node:path')
const {loadRun, jsonRequest} = require('./embed-upload')
const {hashText} = require('./chunk-contract')

// Canonical comparison ignores object key order, but preserves array order.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
const fingerprint = value => hashText(JSON.stringify(canonical(value ?? null)))
function planChanges(previous, next) {
  const old = new Map(previous.map(c => [c.id, c])), desired = new Map(next.map(c => [c.id, c]))
  const plan = {add:[], update:[], metadata:[], unchanged:[], delete:[]}
  for (const c of next) {
    const before = old.get(c.id)
    plan[!before ? 'add' : before.content_hash !== c.content_hash ? 'update' : fingerprint(before) !== fingerprint(c) ? 'metadata' : 'unchanged'].push(c.id)
  }
  for (const c of previous) if (!desired.has(c.id)) plan.delete.push(c.id)
  return plan
}
const batches = (items, size=64) => Array.from({length:Math.ceil(items.length/size)}, (_,i)=>items.slice(i*size,(i+1)*size))
function atomic(file, value) { fs.writeFileSync(file+'.tmp',JSON.stringify(value,null,2));fs.renameSync(file+'.tmp',file) }
function loadPair(previousFile, nextFile) {
  const previous=loadRun(previousFile), next=loadRun(nextFile)
  for (const run of [previous,next]) {
    if(run.manifest.mode!=='full' || !run.manifest.scope || !run.manifest.source_repo) throw new Error('Incremental reconciliation requires complete FULL manifests. Selected runs cannot authorize deletions.')
    if(run.chunks.some(c=>c.metadata.source_repo!==run.manifest.source_repo))throw new Error('Chunk source repository mismatch.')
  }
  if(previous.manifest.source_repo!==next.manifest.source_repo || previous.manifest.scope!==next.manifest.scope)throw new Error('Source repository and scope must match; scope migrations need a separate collection.')
  return {previous,next}
}
async function runIncremental({previousFile,nextFile,stateDir,model,dimensions,collection,qdrantUrl,qdrantKey,geminiKey,taskType='',execute=false,fetcher=fetch,onCheckpoint=async()=>{}}) {
  const {previous,next}=loadPair(previousFile,nextFile)
  const plan=planChanges(previous.chunks,next.chunks)
  const counts=Object.fromEntries(Object.entries(plan).map(([k,v])=>[k,v.length]))
  console.log(JSON.stringify({from:previous.manifest.source_commit,to:next.manifest.source_commit,...counts,execute}))
  if(!execute)return {plan,counts}
  if(!model || !Number.isInteger(dimensions) || dimensions<1 || !/^[a-zA-Z0-9_-]+$/.test(collection||'') || !qdrantUrl || !stateDir)throw new Error('Execution requires model, dimensions, collection, QDRANT_URL and --state-dir.')
  model=model.replace(/^models\//,'')
  const base=new URL(qdrantUrl)
  if(base.username||base.password||base.search||base.hash)throw new Error('QDRANT_URL must not contain credentials/query parameters.')
  const config={model,dimensions,task_type:taskType,normalization:'l2',collection,qdrant_url:base.href,source_repo:next.manifest.source_repo,scope:next.manifest.scope}
  const payload=c=>({...c,embedding_model:model,embedding_dimensions:dimensions,embedding_task_type:taskType,embedding_normalization:'l2'})
  const configHash=fingerprint(config), from=fingerprint(previous.manifest), to=fingerprint(next.manifest)
  const root=path.resolve(stateDir);fs.mkdirSync(root,{recursive:true})
  const fd=fs.openSync(path.join(root,'incremental.lock'),'wx')
  try {
    const stateFile=path.join(root,'incremental-state.json')
    let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):null
    if(state && (state.config_hash!==configHash || (state.status==='running' ? state.from!==from || state.to!==to : state.to!==from && state.to!==to)))throw new Error('Checkpoint mismatch: resume the pending run or use the last successful manifest.')
    if(state?.status==='complete' && state.to===to)return {plan,counts,status:'already-complete'}
    const url=base.href.replace(/\/$/,'')+'/collections/'+encodeURIComponent(collection)
    const headers={'Content-Type':'application/json',...(qdrantKey?{'api-key':qdrantKey}:{})}
    const request=(suffix,method,body)=>jsonRequest(url+suffix,method,headers,body,fetcher).then(r=>{if(r.notFound)throw new Error('Required Qdrant collection/resource missing. Upload the baseline first.');return r})
    const info=await request('','GET')
    const vectors=info.result?.config?.params?.vectors
    if(vectors?.size!==dimensions || vectors?.distance!=='Cosine')throw new Error('Qdrant vector configuration mismatch.')
    const ids=[...new Set([...previous.chunks,...next.chunks].map(c=>c.id))]
    const remote=new Map()
    async function retrieve() {
      const points=new Map()
      for(const group of batches(ids)) {
        const result=await request('/points','POST',{ids:group,with_payload:true,with_vector:false})
        if(!Array.isArray(result.result))throw new Error('Invalid Qdrant retrieve response.')
        for(const p of result.result)points.set(p.id,p.payload)
      }
      return points
    }
    const old=new Map(previous.chunks.map(c=>[c.id,c])), desired=new Map(next.chunks.map(c=>[c.id,c]))
    for(const [id,p] of await retrieve()) {
      // Reject drift or an ID collision before any writes, including mismatched embedding models.
      if(![old.get(id),desired.get(id)].filter(Boolean).some(c=>fingerprint(payload(c))===fingerprint(p)))throw new Error('Qdrant payload drift/configuration mismatch at '+id)
      remote.set(id,p)
    }
    if(!state) {
      // A fresh checkpoint can adopt only a verified, completely uploaded baseline.
      for(const c of previous.chunks)if(fingerprint(remote.get(c.id))!==fingerprint(payload(c)))throw new Error('Baseline does not match Qdrant. Finish the baseline upload before incremental ingestion.')
      for(const c of next.chunks)if(!old.has(c.id)&&remote.has(c.id))throw new Error('New ID already exists outside the baseline.')
    }
    state={config_hash:configHash,from,to,status:'running',source_commit:next.manifest.source_commit}
    await onCheckpoint(state) // Persist remotely before the first Qdrant mutation.
    atomic(stateFile,state)
    const cacheDir=path.join(root,'embedding-cache',fingerprint({model,dimensions,taskType,normalization:'l2'}));fs.mkdirSync(cacheDir,{recursive:true})
    // Upsert replacement text before deleting obsolete IDs. Existing vectors survive metadata-only updates.
    for(const group of batches(next.chunks,32)) {
      const points=[], metadataOperations=[]
      for(const c of group) {
        const present=remote.get(c.id), target=payload(c)
        if(present?.content_hash===c.content_hash) {
          if(fingerprint(present)!==fingerprint(target))metadataOperations.push({overwrite_payload:{points:[c.id],payload:target}})
          continue
        }
        const cache=path.join(cacheDir,c.content_hash+'.json')
        let vector
        if(fs.existsSync(cache))vector=JSON.parse(fs.readFileSync(cache,'utf8'))
        else {
          if(!geminiKey)throw new Error('Set GEMINI_API_KEY to embed changed/new text.')
          const result=await jsonRequest(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:embedContent`,'POST',{'Content-Type':'application/json','x-goog-api-key':geminiKey},{content:{parts:[{text:c.text}]},outputDimensionality:dimensions,...(taskType?{taskType}:{})},fetcher)
          vector=result.embedding?.values
          if(!Array.isArray(vector)||vector.length!==dimensions||vector.some(v=>!Number.isFinite(v)))throw new Error('Invalid embedding.')
          const norm=Math.hypot(...vector);if(!norm)throw new Error('Zero embedding.')
          vector=vector.map(v=>v/norm);atomic(cache,vector)
        }
        if(!Array.isArray(vector)||vector.length!==dimensions||vector.some(v=>!Number.isFinite(v))||Math.abs(Math.hypot(...vector)-1)>1e-5)throw new Error('Invalid cached vector.')
        points.push({id:c.id,vector,payload:target})
      }
      if(metadataOperations.length)await request('/points/batch?wait=true','POST',{operations:metadataOperations})
      if(points.length)await request('/points?wait=true','PUT',{points})
    }
    for(const group of batches(plan.delete))await request('/points/delete?wait=true','POST',{points:group})
    const verified=await retrieve()
    for(const c of next.chunks)if(fingerprint(verified.get(c.id))!==fingerprint(payload(c)))throw new Error('Final verification failed at '+c.id)
    for(const id of plan.delete)if(verified.has(id))throw new Error('Obsolete point still exists: '+id)
    await onCheckpoint({...state,status:'complete'})
    atomic(stateFile,{...state,status:'complete'})
    return {plan,counts,status:'complete'}
  } finally {fs.closeSync(fd);fs.unlinkSync(path.join(root,'incremental.lock'))}
}
if(require.main===module) {
  const args=process.argv.slice(2),options={}
  for(let i=0;i<args.length;i++) {
    if(args[i]==='--execute'){options.execute=true;continue}
    if(!['--previous','--next','--state-dir'].includes(args[i])||!args[i+1])throw new Error('Usage: incremental.js --previous BASELINE_MANIFEST --next NEW_FULL_MANIFEST [--state-dir PATH] [--execute]')
    options[args[i]]=args[++i]
  }
  runIncremental({previousFile:options['--previous'],nextFile:options['--next'],stateDir:options['--state-dir'],execute:options.execute,model:process.env.EMBEDDING_MODEL,dimensions:Number(process.env.EMBEDDING_DIMENSIONS),collection:process.env.QDRANT_COLLECTION,qdrantUrl:process.env.QDRANT_URL,qdrantKey:process.env.QDRANT_API_KEY,geminiKey:process.env.GEMINI_API_KEY,taskType:process.env.EMBEDDING_TASK_TYPE||''}).catch(e=>{console.error(e.message);process.exitCode=1})
}
module.exports={planChanges,loadPair,runIncremental,fingerprint}
