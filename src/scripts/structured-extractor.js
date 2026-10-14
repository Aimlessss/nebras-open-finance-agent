const fs = require('node:fs')
const path = require('node:path')
const { parse } = require('@vue/compiler-dom')
const { dataLoader, scriptValues } = require('./source-data')
const { hashText } = require('./chunk-contract')
function plain(html) {
  let text='';function walk(n){if(n.type===2)text+=n.content;for(const c of n.children||[])walk(c);if(n.type===1)text+='\n'};walk(parse(String(html||'')));return text.trim()
}
function blocks(s) {
  const out=[]
  for(const c of s.callouts||[])out.push({type:'paragraph',text:[c.title,plain(c.html)].filter(Boolean).join(': ')})
  for(const b of s.blocks||[]) {
    if(b.kind==='prose')out.push({type:'paragraph',text:plain(b.html)})
    else if(b.kind==='table')out.push(table(b.table))
    else throw new Error('Unsupported requirements block: '+b.kind)
  }
  if(s.rules?.length)out.push({type:'table',headers:['Field','Rule','Validated by'],rows:s.rules.map(r=>[plain(r.field),plain(r.rule),plain(r.validatedBy)])})
  if(s.table)out.push(table(s.table))
  return out
}
function table(t){return {type:'table',headers:t.headers.map(plain),rows:t.rows.map(r=>(r.cells||r).map(plain))}}
function requirements(data) {
  const sections=[]
  function section(s,parents=[]) {
    sections.push({heading:[...parents,s.title||s.heading].filter(Boolean).join(' > '),anchor:s.id||null,blocks:blocks(s),subsections:[]})
    for(const child of s.subsections||[])section(child,[...parents,s.title||s.heading])
  }
  for(const s of data.sections||[])section(s)
  return {title:data.title,intro:[data.lede,data.preconditions].filter(Boolean).map(t=>({type:'paragraph',text:plain(t)})),sections}
}
function extractStructured(descriptor, root, version) {
  const template=descriptor.template?.content||'',script=descriptor.scriptSetup?.content||''
  const assets=[],dependencies=[];let content=null
  if (/from\s*['"]@\/data\/requirements\//.test(script)) {
    const loaded=scriptValues(script,root)
    if(!loaded.values.data)throw new Error('Requirements module has no data export')
    content=requirements(loaded.values.data)
    assets.push(...loaded.assets.values());dependencies.push(...loaded.assets.keys())
  }
  function walk(n) {
    if(n.type===1&&['fcmultipaymentexplainer','fcdelegatedscaexplainer','fccertlanding'].includes(n.tag.toLowerCase())) {
      const loaded=scriptValues(script,root)
      const attr=name=>n.props.find(p=>p.type===6&&p.name===name)?.value?.content
      assets.push(...loaded.assets.values());dependencies.push(...loaded.assets.keys())
      if(n.tag.toLowerCase()==='fccertlanding') {
        const cards=loaded.evaluate('cards')
        content={title:attr('title'),intro:[{type:'paragraph',text:attr('lede')}],sections:cards.map(c=>({heading:c.title,blocks:[{type:'code',text:JSON.stringify(c,null,2)}],subsections:[]}))}
      } else {
        const area=loaded.evaluate('area')
        const relative='src/components/common/functional-certification/'+(n.tag.toLowerCase()==='fcdelegatedscaexplainer'?'FcDelegatedScaExplainer.vue':'FcMultiPaymentExplainer.vue')
        const raw=fs.readFileSync(path.join(root,relative),'utf8')
        let shared=require('@vue/compiler-sfc').parse(raw).descriptor.template.content
        if(!area.beneficiaryModels?.length)shared=shared.replace(/<EdNote v-if="area.beneficiaryModels\?\.length"[^>]*>[\s\S]*?<\/EdNote>/,'')
        shared=shared.replace(/\{\{([\s\S]*?)\}\}/g,(_,expression)=>String(loaded.evaluate(expression.trim())??''))
        content={title:'Functional Certification — '+area.label,intro:[{type:'paragraph',text:plain(shared)}],sections:[{heading:'Certification configuration',blocks:[{type:'code',text:JSON.stringify(area,null,2)}],subsections:[]}]}
        assets.push({file:relative,hash:hashText(raw)});dependencies.push(relative)
      }
    }
    if(n.type===1&&n.tag.toLowerCase()==='fieldmapendpointpage') {
      const attr=name=>n.props.find(p=>p.type===6&&p.name===name)?.value?.content
      const slug=attr('slug'),v=attr('version')||version
      if(!slug||!/^[a-zA-Z0-9_-]+$/.test(slug))throw new Error('Field-map slug is missing or dynamic')
      const loader=dataLoader(root);const versions=loader.load(path.join(root,'src/data/versions.ts'));const dir=versions.FIELD_MAP_DIR[v]
      if(!dir)throw new Error('No field-map directory for '+v)
      const relative=`public/api/${dir}/resources/${slug}.json`,file=fs.realpathSync(path.join(root,relative))
      if(!file.startsWith(path.resolve(root,'public/api')+path.sep))throw new Error('Field-map asset escapes public/api')
      const raw=fs.readFileSync(file,'utf8'),data=JSON.parse(raw)
      if(!Array.isArray(data.records)||!data.records.length)throw new Error('Field-map contains no records: '+relative)
      content={title:attr('title'),intro:[{type:'paragraph',text:`Documentation version: ${v}. Field-map data version: ${data.version}. ${JSON.stringify(data.operations)}`}],sections:data.records.map(r=>({heading:`Field ${r.ozonePath||'Hub-generated'} → ${r.standardsPath||'Unmapped'}${r.variant?' ('+r.variant+')':''}`,blocks:[{type:'code',text:JSON.stringify(r,null,2)}],subsections:[]}))}
      assets.push({file:relative,hash:hashText(raw)},...loader.assets.values());dependencies.push(relative,...loader.assets.keys())
    }
    for(const c of n.children||[])walk(c)
  }
  walk(parse(template))
  return {content,assets,dependencies}
}
module.exports={extractStructured,requirements,plain}
