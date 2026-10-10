const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const babel = require('@babel/parser')
const { hashText } = require('./chunk-contract')
function dataLoader(root) {
  const ts = require('typescript')
  const cache = new Map(), assets = new Map()
  function load(file) {
    const candidates = [file, file + '.ts', path.join(file, 'index.ts')]
    file = fs.realpathSync(candidates.find(f => fs.existsSync(f) && fs.statSync(f).isFile()) || file)
    if (!file.startsWith(path.resolve(root, 'src/data') + path.sep)) throw new Error('Data imports must remain under src/data: ' + file)
    if (cache.has(file)) return cache.get(file)
    const raw = fs.readFileSync(file, 'utf8')
    assets.set(path.relative(root, file), { file: path.relative(root, file), hash: hashText(raw) })
    const module = { exports: {} }; cache.set(file, module.exports)
    const js = ts.transpileModule(raw, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
    const requireLocal = specifier => {
      if (!specifier.startsWith('.')) throw new Error('Nonlocal data import is unsupported: ' + specifier)
      return load(path.resolve(path.dirname(file), specifier))
    }
    // Trusted documentation data only. No process, network, filesystem or package access.
    vm.runInNewContext(js, { module, exports: module.exports, require: requireLocal }, { filename: file, timeout: 3000 })
    cache.set(file, module.exports)
    return module.exports
  }
  return { load, assets }
}
function scriptValues(script, root) {
  const ast = babel.parse(script || '', { sourceType: 'module', plugins: ['typescript'] })
  const loader = dataLoader(root), values = {}, definitions = new Map()
  for (const node of ast.program.body) {
    if (node.type === 'ImportDeclaration' && node.importKind !== 'type' && node.source.value.startsWith('@/data/')) {
      const data = loader.load(path.join(root, 'src', node.source.value.slice(2)))
      for (const s of node.specifiers) if (s.type === 'ImportSpecifier' && s.importKind !== 'type') values[s.local.name] = data[s.imported.name]
    }
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) if (d.id.type === 'Identifier') definitions.set(d.id.name, d.init)
  }
  function evaluate(n) {
    if (!n) throw new Error('Missing static expression')
    if (['TSAsExpression','TSSatisfiesExpression','TSNonNullExpression'].includes(n.type)) return evaluate(n.expression)
    if (['StringLiteral','NumericLiteral','BooleanLiteral'].includes(n.type)) return n.value
    if (n.type === 'NullLiteral') return null
    if (n.type === 'Identifier') {
      if (Object.hasOwn(values,n.name)) return values[n.name]
      if (!definitions.has(n.name)) throw new Error('Unresolved static identifier: ' + n.name)
      const value = evaluate(definitions.get(n.name));values[n.name]=value;return value
    }
    if (n.type === 'TemplateLiteral') return n.quasis.map((q,i)=>q.value.cooked+(i<n.expressions.length?evaluate(n.expressions[i]):'')).join('')
    if (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression') { const object=evaluate(n.object); if(object==null && n.optional)return undefined; return object[n.computed?evaluate(n.property):n.property.name] }
    if (n.type === 'CallExpression' && n.callee.type === 'MemberExpression' && n.callee.property.name === 'join') { const array=evaluate(n.callee.object); if(!Array.isArray(array))throw new Error('join requires an array'); return array.join(...n.arguments.map(evaluate)) }
    if (n.type === 'ArrayExpression') return n.elements.flatMap(e=>e.type==='SpreadElement'?evaluate(e.argument):[evaluate(e)])
    if (n.type === 'ObjectExpression') {
      const result={};for(const p of n.properties) {if(p.type==='SpreadElement')Object.assign(result,evaluate(p.argument));else if(p.type==='ObjectProperty')result[p.computed?evaluate(p.key):(p.key.name||p.key.value)]=evaluate(p.value);else throw new Error('Unsupported object method')};return result
    }
    throw new Error('Unsupported static expression: '+n.type)
  }
  const expression = text => evaluate(babel.parseExpression(text, { plugins:['typescript'] }))
  return { values, evaluate:expression, assets:loader.assets }
}
module.exports = { dataLoader, scriptValues }
