const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const { parse } = require('@vue/compiler-dom')
const { hashText } = require('./chunk-contract')
const { scriptValues } = require('./source-data')

const specCache = new Map()

// Extract the schema data behind static RedocWrapper pages without running Vue.
function extractOpenApi(template, root, script = "") {
  let bindings
  const evaluate = expression => { bindings ||= scriptValues(script, root); return bindings.evaluate(expression) }
  const sections = [], dependencies = [], assets = []
  function attr(node, name) {
    const p = node.props.find(p => (p.type === 6 && p.name === name) || (p.type === 7 && p.name === 'bind' && p.arg?.content === name))
    if (!p) return undefined
    if (p.type === 6) return p.value?.content || ''
    const expression = p.exp?.content || ''
    if (/^(['"]).*\1$/.test(expression)) return expression.slice(1, -1)
    return evaluate(expression)
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
      if (node.props.some(p => p.arg?.content === 'specText' || p.name === 'specText')) throw new Error('Raw specText imports require explicit resolution before ingestion.')
      const specPath = attr(node, 'spec')
      if (!specPath || !specPath.startsWith('/openapi/') || specPath.includes('..') || /[?#]/.test(specPath)) throw new Error('RedocWrapper requires a local /openapi/ asset; dynamic routes need explicit resolution.')
      const publicRoot = path.resolve(root, 'public')
      const file = fs.realpathSync(path.join(publicRoot, specPath))
      if (!file.startsWith(publicRoot + path.sep)) throw new Error('OpenAPI asset escapes public directory.')
      const raw = fs.readFileSync(file, 'utf8')
      const hash = hashText(raw)
      if (!specCache.has(hash)) specCache.set(hash, YAML.parse(raw))
      let spec = specCache.get(hash)
      const patches = attr(node, 'patchSchemas')
      if (patches) {
        spec = structuredClone(spec)
        for (const [name, value] of Object.entries(patches)) {
          if (!spec.components?.schemas?.[name]) throw new Error('Schema patch target is missing: ' + name)
          spec.components.schemas[name] = value
        }
      }
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
        servers = evaluate(overrides.exp.content)
      }
      const blocks = [{ type: 'code', text: JSON.stringify({ info: spec.info, servers, source_path: filter, display_path: display, ...(schema ? { schema: copy } : { operations: copy }), ...(!hideSecurity && spec.security ? { security: spec.security, securitySchemes: spec.components?.securitySchemes } : {}) }, null, 2) }]
      sections.push({ heading, blocks, subsections: [] })
      for (const [ref, definition] of collectReferences(spec, copy)) sections.push({ heading: `OpenAPI definition ${ref}`, blocks: [{ type: 'code', text: JSON.stringify(definition, null, 2) }], subsections: [] })
    }
    for (const child of node.children || []) walk(child)
  }
  walk(parse(template || ''))
  if (bindings) { dependencies.push(...bindings.assets.keys()); assets.push(...bindings.assets.values()) }
  return { sections, dependencies, assets }
}
module.exports = { extractOpenApi }
