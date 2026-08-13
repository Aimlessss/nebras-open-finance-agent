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
  "scripts/rag/output/tpp-standards.json",
)

const inputPath = path.resolve(process.argv[2] || defaultInput)
const outputPath = path.resolve(process.argv[3] || defaultOutput)

// ---------------------------------------------------------
// Helpers
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
    .replace(/<code>(.*?)<\/code>/g, "$1")
}

function cleanText(text) {
  return decodeHtml(text)
    .replace(/\s+/g, " ")
    .trim()
}

// ---------------------------------------------------------
// Parse Vue file
// ---------------------------------------------------------

function parseVueFile(filePath) {
  const source = fs.readFileSync(filePath, "utf8")

  const { descriptor, errors } = parseVue(source, {
    filename: filePath,
  })

  if (errors.length > 0) {
    throw new Error(
      `Could not parse ${filePath}:\n${errors
        .map(String)
        .join("\n")}`,
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
// Babel / Script AST
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
// AST -> normal JS
// ---------------------------------------------------------

function astToValue(node) {
  if (!node) {
    return null
  }

  switch (node.type) {
    case "StringLiteral":
      return decodeHtml(node.value)

    case "NumericLiteral":
      return node.value

    case "BooleanLiteral":
      return node.value

    case "NullLiteral":
      return null

    case "ArrayExpression":
      return node.elements
        .filter(Boolean)
        .map((element) => astToValue(element))

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

  for (
    let i = 0;
    i < node.quasis.length;
    i++
  ) {
    result += node.quasis[i].value.cooked ?? ""

    if (i < node.expressions.length) {
      result += expressionToString(
        node.expressions[i],
      )
    }
  }

  return decodeHtml(result)
}

function expressionToString(node) {
  // selectedVersion.value
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

  // selectedVersion
  if (
    node.type === "Identifier" &&
    node.name === "selectedVersion"
  ) {
    return "{version}"
  }

  return "{dynamic}"
}

// ---------------------------------------------------------
// Extract sections
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

      // Support:
      //
      // () => {
      //   return [...]
      // }
      if (arrayNode.type === "BlockStatement") {
        const returnStatement =
          arrayNode.body.find(
            (statement) =>
              statement.type ===
              "ReturnStatement",
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

// ---------------------------------------------------------
// Clean section data
// ---------------------------------------------------------

function cleanSections(sections) {
  return sections.map((section) => {
    const cleaned = {
      category: section.category,
      title: cleanText(section.title ?? ""),
      url: section.url,
      description: cleanText(
        section.desc ?? "",
      ),
    }

    if (section.tags?.length) {
      cleaned.tags = section.tags.map(cleanText)
    }

    if (section.subItems?.length) {
      cleaned.subItems = section.subItems.map(
        (subItem) => ({
          label: cleanText(subItem.label ?? ""),

          ...(subItem.hint
            ? {
                hint: cleanText(
                  subItem.hint,
                ),
              }
            : {}),

          url: subItem.url,
        }),
      )
    }

    return cleaned
  })
}

// ---------------------------------------------------------
// Template text extraction
// ---------------------------------------------------------

function extractStaticTextFromNode(node) {
  if (!node) {
    return ""
  }

  // TEXT
  if (node.type === 2) {
    return node.content
  }

  // INTERPOLATION
  //
  // Example:
  // {{ selectedVersion }}
  //
  // Ignore dynamic values for now.
  if (node.type === 5) {
    return ""
  }

  // ELEMENT / ROOT
  if (node.children) {
    return node.children
      .map(extractStaticTextFromNode)
      .join(" ")
  }

  return ""
}

function extractTemplateContent(descriptor) {
  if (!descriptor.template?.content) {
    return {
      headings: [],
      paragraphs: [],
    }
  }

  const templateAst = parseTemplate(
    descriptor.template.content,
  )

  const headings = []
  const paragraphs = []

  function walk(node) {
    // Vue compiler:
    // type === 1 means ELEMENT
    if (node.type === 1) {
      const tag = node.tag?.toLowerCase()

      if (
        ["h1", "h2", "h3", "h4", "h5", "h6"]
          .includes(tag)
      ) {
        const text = cleanText(
          extractStaticTextFromNode(node),
        )

        if (text) {
          headings.push({
            level: Number(tag.substring(1)),
            text,
          })
        }
      }

      if (tag === "p") {
        const text = cleanText(
          extractStaticTextFromNode(node),
        )

        if (text) {
          paragraphs.push(text)
        }
      }
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child)
      }
    }
  }

  walk(templateAst)

  return {
    headings: deduplicateHeadings(headings),
    paragraphs: deduplicateStrings(
      paragraphs,
    ),
  }
}

function deduplicateStrings(values) {
  return [...new Set(values)]
}

function deduplicateHeadings(headings) {
  const seen = new Set()

  return headings.filter((heading) => {
    const key =
      `${heading.level}:${heading.text}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

function main() {
  const descriptor = parseVueFile(inputPath)

  // 1. <route>
  const metadata =
    extractMetadata(descriptor)

  // 2. <script setup>
  const scriptAst =
    parseScriptSetup(descriptor)

  const rawSections =
    extractSections(scriptAst)

  const sections =
    cleanSections(rawSections)

  // 3. <template>
  const templateContent =
    extractTemplateContent(descriptor)

  // 4. Final clean document
  const output = {
    id: "tech/tpp-standards",

    source: {
      file: inputPath,
      parser: "vue-sfc",
    },

    metadata,

    content: {
      headings:
        templateContent.headings,

      paragraphs:
        templateContent.paragraphs,
    },

    sections,
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