const fs = require('node:fs')
const path = require('node:path')
const { dataLoader } = require('./source-data')
const { extractOpenApi } = require('./openapi-extractor')
const { finalizeChunks, hashText, PARSER_VERSION } = require('./chunk-contract')
function generatedApiDocs(root, commit) {
  const loader = dataLoader(root)
  const registry = loader.load(path.join(root, 'src/data/endpoints/index.ts'))
  const source = 'src/pages/tech/api-specs/[...slug].vue'
  const sourceHash = hashText(fs.readFileSync(path.join(root,source),'utf8'))
  return registry.allEndpoints.map(e=>({id:registry.endpointUrl(e).replace(/^\//,''),endpoint:e,build(){
    const attrs=Object.entries(e.redoc).map(([k,v])=>`:${k}="${JSON.stringify(v).replace(/&/g,'&amp;').replace(/"/g,'&quot;')}"`).join(' ')
    const extracted=extractOpenApi(`<RedocWrapper ${attrs} />`,root)
    const doc={id:this.id,source:{repo:'Nebras-Open-Finance/community-standards',file:source,hash:sourceHash,commit,parser:'api-registry',parser_version:PARSER_VERSION,dependencies:[...loader.assets.keys(),...extracted.dependencies],assets:[...loader.assets.values(),...extracted.assets],extraction_warnings:[]},metadata:{title:e.title,url:'https://nebras-open-finance.com/'+this.id,doc_version:e.version},content:{title:e.title,intro:[],sections:extracted.sections}}
    const chunks=finalizeChunks(doc,extracted.sections.map(s=>({document_id:doc.id,type:'section',text:[`${e.title} > ${s.heading}`,s.blocks.map(b=>b.text).join('\n\n')].join('\n\n'),metadata:{title:e.title,section:s.heading,source_file:source,parser:'api-registry'}})))
    return {doc,chunks}
  }}))
}
module.exports={generatedApiDocs}
