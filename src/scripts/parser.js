const fs = require("node:fs")
const path = require("node:path")

const { parse: parseVue } = require("@vue/compiler-sfc")
const { parse: parseTemplate } = require("@vue/compiler-dom")
const babelParser = require("@babel/parser")
const YAML = require("yaml")

// ---------------------------------------------------------
// Paths
// ---------------------------------------------------------

const projectRoot = path.resolve(__dirname, "../..")

const defaultInput = path.resolve(
  projectRoot,
  "../community-standards/src/pages/tech/tpp-standards/index.vue",
)

const defaultOutput = path.resolve(
  projectRoot,
  "scripts/rag/output/document.json",
)

const inputPath = path.resolve(process.argv[2] || defaultInput)
const outputPath = path.resolve(process.argv[3] || defaultOutput)

// ---------------------------------------------------------
// Text helpers
// ---------------------------------------------------------

function decodeHtml(text) {
  if (typeof text !== "string") {
    return text
  }

  return text
    .replaceAll("&amp;", "&")
    .replaceAll("&mdash;", "—")
    .replaceAll("&ndash;", "–")
    .replaceAll("&middot;", "·")
    .replaceAll("&rarr;", "→")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .replace(/<code>(.*?)<\/code>/g, "$1")
}

function cleanText(text) {
  return decodeHtml(text || "")
    .replace(/\s+/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim()
}

function isMeaningfulText(text) {
  const cleaned = cleanText(text)

  if (!cleaned) {
    return false
  }

  // Ignore decorative / UI-only symbol content
  if (/^[→←↑↓•·›»‹«\-–—]+$/.test(cleaned)) {
    return false
  }

  return true
}

// ---------------------------------------------------------
// Vue parser
// ---------------------------------------------------------

function parseVueFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8")

  const { descriptor, errors } = parseVue(source, {
    filename: filePath,
  })

  if (errors.length > 0) {
    throw new Error(
      `Could not parse ${filePath}:\n${errors.map(String).join("\n")}`,
    )
  }

  return descriptor
}

// ---------------------------------------------------------
// Route metadata
// ---------------------------------------------------------

function extractMetadata(descriptor) {
  const routeBlock = descriptor.customBlocks.find(
    (block) => block.type === "route",
  )

  if (!routeBlock) {
    return {}
  }

  const route = YAML.parse(routeBlock.content)

  return route?.meta ?? {}
}

// ---------------------------------------------------------
// Babel parsing
// ---------------------------------------------------------

function parseScriptSetup(descriptor) {
  if (!descriptor.scriptSetup) {
    return null
  }

  return babelParser.parse(
    descriptor.scriptSetup.content,
    {
      sourceType: "module",
      plugins: ["typescript"],
    },
  )
}

// ---------------------------------------------------------
// Babel AST -> JS
// ---------------------------------------------------------

function astToValue(node) {
  if (!node) {
    return null
  }

  switch (node.type) {
    case "StringLiteral":
      return cleanText(node.value)

    case "NumericLiteral":
      return node.value

    case "BooleanLiteral":
      return node.value

    case "NullLiteral":
      return null

    case "ArrayExpression":
      return node.elements
        .filter(Boolean)
        .map(astToValue)

    case "ObjectExpression": {
      const result = {}

      for (const property of node.properties) {
        if (property.type !== "ObjectProperty") {
          continue
        }

        let key

        if (property.key.type === "Identifier") {
          key = property.key.name
        } else if (
          property.key.type === "StringLiteral"
        ) {
          key = property.key.value
        } else {
          continue
        }

        result[key] = astToValue(property.value)
      }

      return result
    }

    case "TemplateLiteral":
      return templateLiteralToString(node)

    case "Identifier":
      if (node.name === "undefined") {
        return undefined
      }

      return node.name

    default:
      return null
  }
}

function templateLiteralToString(node) {
  let result = ""

  for (let i = 0; i < node.quasis.length; i++) {
    result += node.quasis[i].value.cooked ?? ""

    if (i < node.expressions.length) {
      result += expressionToString(node.expressions[i])
    }
  }

  return cleanText(result)
}

function expressionToString(node) {
  if (node.type === "MemberExpression") {
    const objectName =
      node.object.type === "Identifier"
        ? node.object.name
        : null

    const propertyName =
      node.property.type === "Identifier"
        ? node.property.name
        : null

    if (
      objectName === "selectedVersion" &&
      propertyName === "value"
    ) {
      return "{version}"
    }
  }

  if (
    node.type === "Identifier" &&
    node.name === "selectedVersion"
  ) {
    return "{version}"
  }

  return "{dynamic}"
}

// ---------------------------------------------------------
// Extract script sections
// ---------------------------------------------------------

function extractSections(ast) {
  if (!ast) {
    return []
  }

  for (const node of ast.program.body) {
    if (node.type !== "VariableDeclaration") {
      continue
    }

    for (const declaration of node.declarations) {
      if (
        declaration.id.type !== "Identifier" ||
        declaration.id.name !== "sections"
      ) {
        continue
      }

      const init = declaration.init

      if (!init || init.type !== "CallExpression") {
        continue
      }

      const callback = init.arguments[0]

      if (
        !callback ||
        callback.type !== "ArrowFunctionExpression"
      ) {
        continue
      }

      let arrayNode = callback.body

      if (arrayNode.type === "BlockStatement") {
        const returnStatement = arrayNode.body.find(
          (statement) =>
            statement.type === "ReturnStatement",
        )

        arrayNode = returnStatement?.argument
      }

      if (
        !arrayNode ||
        arrayNode.type !== "ArrayExpression"
      ) {
        return []
      }

      return astToValue(arrayNode) ?? []
    }
  }

  return []
}

function cleanSections(sections) {
  return sections.map((section) => {
    const result = {}

    if (section.category) {
      result.category = cleanText(section.category)
    }

    if (section.title) {
      result.title = cleanText(section.title)
    }

    if (section.url) {
      result.url = section.url
    }

    if (section.desc) {
      result.description = cleanText(section.desc)
    }

    if (section.tags?.length) {
      result.tags = section.tags
        .map(cleanText)
        .filter(isMeaningfulText)
    }

    if (section.subItems?.length) {
      result.subItems = section.subItems
        .map((item) => ({
          label: cleanText(item.label),

          ...(item.hint
            ? {
                hint: cleanText(item.hint),
              }
            : {}),

          url: item.url,
        }))
        .filter((item) =>
          isMeaningfulText(item.label),
        )
    }

    return result
  })
}

// ---------------------------------------------------------
// Vue template AST helpers
// ---------------------------------------------------------

function getNodeText(node) {
  if (!node) {
    return ""
  }

  // Text node
  if (node.type === 2) {
    return node.content
  }

  // Interpolation: {{ something }}
  // Ignore dynamic interpolation for now.
  if (node.type === 5) {
    return ""
  }

  if (node.children) {
    return node.children
      .map(getNodeText)
      .join(" ")
  }

  return ""
}

function getAttribute(node, name) {
  if (!node?.props) {
    return undefined
  }

  const prop = node.props.find(
    (prop) =>
      prop.type === 6 &&
      prop.name === name,
  )

  return prop?.value?.content
}

// ---------------------------------------------------------
// List extraction
// ---------------------------------------------------------

function extractList(node) {
  const items = []

  for (const child of node.children ?? []) {
    if (
      child.type === 1 &&
      child.tag?.toLowerCase() === "li"
    ) {
      const text = cleanText(
        getNodeText(child),
      )

      if (isMeaningfulText(text)) {
        items.push(text)
      }
    }
  }

  return items
}

// ---------------------------------------------------------
// Find descendants
// ---------------------------------------------------------

function findDescendantsByTag(node, tagName) {
  const found = []

  function walk(current) {
    if (!current) {
      return
    }

    if (
      current.type === 1 &&
      current.tag?.toLowerCase() ===
        tagName.toLowerCase()
    ) {
      found.push(current)
    }

    for (const child of current.children ?? []) {
      walk(child)
    }
  }

  walk(node)

  return found
}

// ---------------------------------------------------------
// Table extraction
// ---------------------------------------------------------

function extractTable(node) {
  const headers = []
  const rows = []

  const headerNodes =
    findDescendantsByTag(node, "th")

  for (const header of headerNodes) {
    const text = cleanText(
      getNodeText(header),
    )

    if (isMeaningfulText(text)) {
      headers.push(text)
    }
  }

  const rowNodes =
    findDescendantsByTag(node, "tr")

  for (const row of rowNodes) {
    const cells = []

    for (const child of row.children ?? []) {
      if (
        child.type === 1 &&
        child.tag?.toLowerCase() === "td"
      ) {
        const text = cleanText(
          getNodeText(child),
        )

        cells.push(text)
      }
    }

    const meaningfulCells =
      cells.filter(isMeaningfulText)

    if (meaningfulCells.length > 0) {
      rows.push(cells)
    }
  }

  return {
    type: "table",
    headers,
    rows,
  }
}

// ---------------------------------------------------------
// Code extraction
// ---------------------------------------------------------

function extractCode(node) {
  const text = cleanText(
    getNodeText(node),
  )

  if (!isMeaningfulText(text)) {
    return null
  }

  return {
    type: "code",
    text,
  }
}

// ---------------------------------------------------------
// Block-based template extraction
// ---------------------------------------------------------

function extractTemplateStructure(descriptor) {
  if (!descriptor.template?.content) {
    return {
      intro: [],
      sections: [],
    }
  }

  const ast = parseTemplate(
    descriptor.template.content,
  )

  const document = {
    intro: [],
    sections: [],
  }

  let currentSection = null
  let currentSubsection = null

  function addBlock(block) {
    if (!block) {
      return
    }

    if (currentSubsection) {
      currentSubsection.blocks.push(block)
      return
    }

    if (currentSection) {
      currentSection.blocks.push(block)
      return
    }

    document.intro.push(block)
  }

  function walk(node) {
    if (!node) {
      return
    }

    if (node.type === 1) {
      const tag = node.tag?.toLowerCase()

      // ---------------------------------------------------
      // H1
      // ---------------------------------------------------

      if (tag === "h1") {
        const text = cleanText(
          getNodeText(node),
        )

        if (isMeaningfulText(text)) {
          document.title = text
        }

        return
      }

      // ---------------------------------------------------
      // H2
      // ---------------------------------------------------

      if (tag === "h2") {
        const text = cleanText(
          getNodeText(node),
        )

        if (isMeaningfulText(text)) {
          currentSection = {
            heading: text,
            level: 2,
            anchor:
              getAttribute(node, "id") ??
              null,
            blocks: [],
            subsections: [],
          }

          document.sections.push(
            currentSection,
          )

          currentSubsection = null
        }

        return
      }

      // ---------------------------------------------------
      // H3 / H4
      // ---------------------------------------------------

      if (
        tag === "h3" ||
        tag === "h4"
      ) {
        const text = cleanText(
          getNodeText(node),
        )

        if (
          isMeaningfulText(text) &&
          currentSection
        ) {
          currentSubsection = {
            heading: text,
            level: Number(tag.slice(1)),
            anchor:
              getAttribute(node, "id") ??
              null,
            blocks: [],
          }

          currentSection.subsections.push(
            currentSubsection,
          )
        }

        return
      }

      // ---------------------------------------------------
      // Paragraph
      // ---------------------------------------------------

      if (tag === "p") {
        const text = cleanText(
          getNodeText(node),
        )

        if (isMeaningfulText(text)) {
          addBlock({
            type: "paragraph",
            text,
          })
        }

        return
      }

      // ---------------------------------------------------
      // UL / OL
      // ---------------------------------------------------

      if (
        tag === "ul" ||
        tag === "ol"
      ) {
        const items = extractList(node)
          .filter(isMeaningfulText)

        if (items.length > 0) {
          addBlock({
            type:
              tag === "ol"
                ? "ordered_list"
                : "list",
            items,
          })
        }

        return
      }

      // ---------------------------------------------------
      // Table
      // ---------------------------------------------------

      if (tag === "table") {
        const table = extractTable(node)

        if (
          table.headers.length > 0 ||
          table.rows.length > 0
        ) {
          addBlock(table)
        }

        return
      }

      // ---------------------------------------------------
      // PRE / code block
      // ---------------------------------------------------

      if (tag === "pre") {
        const code = extractCode(node)

        if (code) {
          addBlock(code)
        }

        return
      }
    }

    // Walk container children
    for (const child of node.children ?? []) {
      walk(child)
    }
  }

  walk(ast)

  return document
}

// ---------------------------------------------------------
// Create document ID from file path
// ---------------------------------------------------------

function createDocumentId(filePath) {
  const normalized = filePath.replace(
    /\\/g,
    "/",
  )

  const marker = "/src/pages/"

  const index =
    normalized.indexOf(marker)

  if (index === -1) {
    return path.basename(
      filePath,
      ".vue",
    )
  }

  let id = normalized.slice(
    index + marker.length,
  )

  id = id.replace(/\/index\.vue$/, "")
  id = id.replace(/\.vue$/, "")

  return id
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

function main() {
  const descriptor =
    parseVueFile(inputPath)

  const metadata =
    extractMetadata(descriptor)

  const scriptAst =
    parseScriptSetup(descriptor)

  const rawScriptSections =
    extractSections(scriptAst)

  const navigationSections =
    cleanSections(rawScriptSections)

  const template =
    extractTemplateStructure(descriptor)

  const output = {
    id: createDocumentId(inputPath),

    source: {
      file: inputPath,
      parser: "vue-sfc",
    },

    metadata,

    content: template,

    ...(navigationSections.length
      ? {
          navigation:
            navigationSections,
        }
      : {}),
  }

  fs.mkdirSync(
    path.dirname(outputPath),
    {
      recursive: true,
    },
  )

  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(
      output,
      null,
      2,
    )}\n`,
  )

  console.log(
    `Wrote ${outputPath}`,
  )

  console.log(
    JSON.stringify(output, null, 2),
  )
}

// ---------------------------------------------------------
// Run
// ---------------------------------------------------------

try {
  main()
} catch (error) {
  console.error(
    error instanceof Error
      ? error.stack
      : error,
  )

  process.exitCode = 1
}