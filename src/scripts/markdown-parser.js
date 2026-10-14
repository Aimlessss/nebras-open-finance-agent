const fs=require('node:fs'),path=require('node:path')
const YAML=require('yaml'),MarkdownIt=require('markdown-it')
const {plain}=require('./structured-extractor')
const {hashText,pageUrl,PARSER_VERSION}=require('./chunk-contract')
const [input,output]=process.argv.slice(2),root=process.env.SOURCE_ROOT
const raw=fs.readFileSync(input,'utf8')
const match=raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
const metadata=match?YAML.parse(match[1])||{}:{}
const body=match?raw.slice(match[0].length):raw
const file=path.relative(root,input).split(path.sep).join('/')
const id=file.replace(/^src\/pages\//,'').replace(/(?:\/index)?\.md$/,'')
const title=metadata.title||body.match(/^#\s+(.+)$/m)?.[1]||id
const text=plain(new MarkdownIt({html:true}).render(body))
const doc={id,source:{repo:'community-standards',file,parser:'markdown',parser_version:PARSER_VERSION,commit:process.env.SOURCE_COMMIT,hash:hashText(raw),dependencies:[],assets:[],extraction_warnings:[]},metadata:{...metadata,title,url:pageUrl(id),doc_version:id.match(/\/(v\d+\.[^/]+)\//)?.[1]||'unversioned'},content:{title,intro:text?[{type:'paragraph',text}]:[],sections:[]}}
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(doc,null,2)+'\n')
