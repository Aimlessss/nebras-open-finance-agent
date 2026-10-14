const fs=require('node:fs')
const path=require('node:path')
const {hashText}=require('./chunk-contract')
// All imported dependencies must have resolved, hashed assets before reuse is safe.
function reusableDocument(doc,root) {
  const assets=doc.assets||[], hashes=new Map(assets.map(a=>[a.file,a.hash]))
  if((doc.dependencies||[]).some(file=>!hashes.has(file)))return false
  const checks=[{file:doc.source_file,hash:doc.source_hash},...assets]
  return checks.every(({file,hash})=>{
    if(!file||!hash)return false
    try {
      const resolved=fs.realpathSync(path.resolve(root,file))
      return resolved.startsWith(root+path.sep)&&hashText(fs.readFileSync(resolved,'utf8'))===hash
    }catch{return false}
  })
}
function copyDocument(doc,previousRoot,output,commit) {
  const chunkFile=path.resolve(previousRoot,doc.chunk_file)
  if(!chunkFile.startsWith(previousRoot+path.sep))throw new Error('Previous chunk path escapes run.')
  const data=JSON.parse(fs.readFileSync(chunkFile,'utf8'))
  data.chunks=data.chunks.map(c=>({...c,metadata:{...c.metadata,source_commit:commit}}))
  const destination=path.join(output,doc.chunk_file)
  fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(data,null,2)+'\n')
  return {...doc,chunks:data.chunks.map(c=>({id:c.id,chunk_key:c.chunk_key,content_hash:c.content_hash}))}
}
module.exports={reusableDocument,copyDocument}
