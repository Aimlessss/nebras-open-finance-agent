const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const { parse } = require('@vue/compiler-dom')
const { hashText } = require('./chunk-contract')

// Extract the schema data behind static RedocWrapper pages without running Vue.
function extractOpenApi(template, root) {
  const sections = [], dependencies = [], assets = []
  function attr(node, name) {
    const p = node.props.find(p => (p.type === 6 && p.name === name) || (p.type === 7 && p.name === 'bind' && p.arg?.content === name))
    if (!p) return undefined
    if (p.type === 6) return p.value?.content || ''
    const expression = p.exp?.content || ''
    if (/^(['"]).*\1$/.test(expression)) return expression.slice(1, -1)
    throw new Error(`RedocWrapper ${name} is dynamic; resolve it through the website route registry before ingestion.`)
  }
  function collectReferences(spec, value) {
    const found = new Map()
    function walk(value) {
      if (!value || typeof value !== 'object') return
      if (value.$ref) {
        const ref = value.$ref
        if (!ref.startsWith('#/')) throw new Error(`External OpenAPI reference requires resolution: ${ref}`)
        if (!found.has(ref)) {
          const target = ref.slice(2).split('/').reduce((obj, key) => obj?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], spec)
          if (target === undefined) throw new Error(`Unresolved OpenAPI reference: ${ref}`)
          found.set(ref, target)
          walk(target)
        }
      }
      for (const item of Object.values(value)) walk(item)
    }
    walk(value)
    return found
  }
  function walk(node) {
    if (node.type === 1 && node.tag.toLowerCase() === 'redocwrapper') {
      if (node.props.some(p => (p.type === 6 && ['patchSchemas', 'specText', 'overrideServers'].includes(p.name)) || (p.type === 7 && ['patchSchemas', 'specText', 'overrideServers'].includes(p.arg?.content)))) {
        // Literal server arrays are handled below; schema patches/raw documents need explicit resolution.
        if (node.props.some(p => ['patchSchemas', 'specText'].includes(p.name === 'bind' ? p.arg?.content : p.name))) throw new Error('RedocWrapper schema patches/specText require explicit resolution before ingestion.')
      }
      const specPath = attr(node, 'spec')
      if (!specPath || !specPath.startsWith('/openapi/') || specPath.includes('..') || /[?#]/.test(specPath)) throw new Error('RedocWrapper requires a local /openapi/ asset; dynamic routes need explicit resolution.')
      const publicRoot = path.resolve(root, 'public')
      const file = fs.realpathSync(path.join(publicRoot, specPath))
      if (!file.startsWith(publicRoot + path.sep)) throw new Error('OpenAPI asset escapes public directory.')
      const raw = fs.readFileSync(file, 'utf8')
      const spec = YAML.parse(raw)
      if (!spec?.openapi || !spec.paths) throw new Error(`Invalid OpenAPI document: ${specPath}`)
      dependencies.push('public' + specPath)
      assets.push({ file: 'public' + specPath, hash: hashText(raw) })
      const filter = attr(node, 'filterPath'), method = attr(node, 'filterMethod'), schema = attr(node, 'filterSchema'), display = attr(node, 'displayPath')
      const hideSecurity = node.props.some(p => p.arg?.content === 'hideSecurity' && p.exp?.content === 'true')
      const selected = schema ? spec.components?.schemas?.[schema] : filter ? spec.paths[filter] : spec.paths
      if (!selected) throw new Error(`OpenAPI selection does not exist: ${schema || filter}`)
      let value = selected
      if (method) {
        if (!selected[method.toLowerCase()]) throw new Error(`OpenAPI method does not exist: ${method}`)
        value = { [method.toLowerCase()]: selected[method.toLowerCase()] }
      }
      const copy = JSON.parse(JSON.stringify(value))
      if (hideSecurity && !schema) for (const operation of Object.values(copy)) if (operation && typeof operation === 'object') delete operation.security
      const heading = schema ? `Schema ${schema}` : `API ${display || filter || 'operations'}`
      const overrides = node.props.find(p => p.arg?.content === 'overrideServers')
      let servers = spec.servers
      if (overrides) {
        // Only literal data accepted; never execute the expression.
        const parser = require('@babel/parser')
        const ast = parser.parseExpression(overrides.exp.content, { plugins: ['typescript'] })
        function literal(n) {
          if (n.type === 'StringLiteral') return n.value
          if (n.type === 'ArrayExpression') return n.elements.map(literal)
          if (n.type === 'ObjectExpression') return Object.fromEntries(n.properties.map(p => {
            if (p.type !== 'ObjectProperty' || p.computed) throw new Error('Dynamic overrideServers is unsupported.')
            return [p.key.name || p.key.value, literal(p.value)]
          }))
          throw new Error('Dynamic overrideServers is unsupported.')
        }
        servers = literal(ast)
      }
      const blocks = [{ type: 'code', text: JSON.stringify({ info: spec.info, servers, source_path: filter, display_path: display, ...(schema ? { schema: copy } : { operations: copy }), ...(!hideSecurity && spec.security ? { security: spec.security, securitySchemes: spec.components?.securitySchemes } : {}) }, null, 2) }]
      sections.push({ heading, blocks, subsections: [] })
      for (const [ref, definition] of collectReferences(spec, copy)) sections.push({ heading: `OpenAPI definition ${ref}`, blocks: [{ type: 'code', text: JSON.stringify(definition, null, 2) }], subsections: [] })
    }
    for (const child of node.children || []) walk(child)
  }
  walk(parse(template || ''))
  return { sections, dependencies, assets }
}
module.exports = { extractOpenApi }
