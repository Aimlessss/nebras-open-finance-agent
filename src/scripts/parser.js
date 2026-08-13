const fs = require("node:fs")
const path = require("node:path")
const { parse: parseVue } = require("@vue/compiler-sfc")
const babelParser = require("@babel/parser")
const YAML = require("yaml")

// ---------------------------------------------------------
// Paths
// ---------------------------------------------------------

const projectRoot = path.resolve(__dirname, "../..")
//Users/atharva.kulkarni/Desktop/nebras-open-finance-agent/community-standards/src/pages/tech/tpp-standards/trust-framework/index.vue
//Users/atharva.kulkarni/Desktop/nebras-open-finance-agent/community-standards/src/pages/tech/tpp-standards/index.vue
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
// Small helpers
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
// Extract route metadata
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
// AST helpers
// ---------------------------------------------------------

/**
 * Converts the limited JavaScript/TypeScript AST structures
 * used by our documentation config into normal JS values.
 *
 * This is NOT a general JavaScript evaluator.
 */
function astToValue(node) {
  if (!node) {
    return null
  }

  switch (node.type) {
    // "hello"
    case "StringLiteral":
      return decodeHtml(node.value)

    // 123
    case "NumericLiteral":
      return node.value

    // true / false
    case "BooleanLiteral":
      return node.value

    // null
    case "NullLiteral":
      return null

    // ["a", "b"]
    case "ArrayExpression":
      return node.elements
        .filter(Boolean)
        .map((element) => astToValue(element))

    // { title: "...", tags: [...] }
    case "ObjectExpression": {
      const result = {}

      for (const property of node.properties) {
        if (property.type !== "ObjectProperty") {
          continue
        }

        let key

        if (property.key.type === "Identifier") {
          key = property.key.name
        } else if (property.key.type === "StringLiteral") {
          key = property.key.value
        } else {
          continue
        }

        result[key] = astToValue(property.value)
      }

      return result
    }

    // `/tech/${selectedVersion.value}/banking`
    case "TemplateLiteral":
      return templateLiteralToString(node)

    // identifiers such as undefined
    case "Identifier":
      if (node.name === "undefined") {
        return undefined
      }

      return node.name

    default:
      console.warn(
        `Skipping unsupported AST node: ${node.type}`,
      )

      return null
  }
}

// ---------------------------------------------------------
// Convert template literal
// ---------------------------------------------------------

function templateLiteralToString(node) {
  let result = ""

  for (let i = 0; i < node.quasis.length; i++) {
    result += node.quasis[i].value.cooked ?? ""

    if (i < node.expressions.length) {
      result += expressionToString(node.expressions[i])
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
// Parse <script setup>
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
// Find sections variable
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
      // Looking for:
      //
      // const sections = ...
      //

      if (
        declaration.id.type !== "Identifier" ||
        declaration.id.name !== "sections"
      ) {
        continue
      }

      const init = declaration.init

      if (!init) {
        continue
      }

      /*
       * Expected structure:
       *
       * const sections = computed<SectionConfig[]>(() => [
       *    ...
       * ])
       *
       * AST:
       *
       * CallExpression
       *   └── arguments[0]
       *         └── ArrowFunctionExpression
       *               └── body
       *                     └── ArrayExpression
       */

      if (init.type !== "CallExpression") {
        throw new Error(
          "`sections` is not initialized using a function call",
        )
      }

      const callback = init.arguments[0]

      if (
        !callback ||
        callback.type !== "ArrowFunctionExpression"
      ) {
        throw new Error(
          "Could not find sections arrow function",
        )
      }

      let arrayNode = callback.body

      // Support:
      //
      // () => {
      //   return [...]
      // }
      //
      if (arrayNode.type === "BlockStatement") {
        const returnStatement = arrayNode.body.find(
          (statement) =>
            statement.type === "ReturnStatement",
        )

        arrayNode = returnStatement?.argument
      }

      if (!arrayNode) {
        return []
      }

      if (arrayNode.type !== "ArrayExpression") {
        throw new Error(
          "Sections function does not return an array",
        )
      }

      const sections = astToValue(arrayNode)

      return sections ?? []
    }
  }

  return []
}

// ---------------------------------------------------------
// Extract sections declared in the Vue template
// ---------------------------------------------------------

function getStaticAttribute(element, name) {
  const attribute = element.props.find(
    (prop) => prop.type === 6 && prop.name === name,
  )

  return attribute?.value
    ? decodeHtml(attribute.value.content)
    : undefined
}

function extractText(node) {
  if (!node) {
    return ""
  }

  // Plain text
  if (node.type === 2) {
    return decodeHtml(node.content)
  }

  // {{ interpolation }}
  if (node.type === 5) {
    return node.loc.source
  }

  if (!Array.isArray(node.children)) {
    return ""
  }

  return node.children
    .map((child) => extractText(child))
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Documentation pages declare their sections in one of two ways:
 *
 * 1. A `sections` config array in <script setup> (the landing page).
 * 2. <EdSectionBand> components in <template> (content pages).
 *
 * This extracts the second form into the same shape as the config array.
 */
function extractTemplateSections(descriptor) {
  const root = descriptor.template?.ast

  if (!root) {
    return []
  }

  const sections = []

  function visit(node) {
    if (!node || typeof node !== "object") {
      return
    }

    // Vue compiler AST: type 1 is an Element node.
    if (node.type === 1 && node.tag === "EdSectionBand") {
      const id = getStaticAttribute(node, "id")
      const title = getStaticAttribute(node, "title")
      const eyebrow = getStaticAttribute(node, "eyebrow")
      const description = extractText(node)

      sections.push({
        category: eyebrow,
        title,
        url: id ? `#${id}` : undefined,
        desc: description,
      })
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child)
      }
    }
  }

  visit(root)
  return sections
}

// ---------------------------------------------------------
// Clean sections
// ---------------------------------------------------------

function cleanSections(sections) {
  return sections.map((section) => {
    const cleaned = {
      category: section.category,
      title: section.title,
      url: section.url,
      description: section.desc,
    }

    if (section.tags?.length) {
      cleaned.tags = section.tags
    }

    if (section.subItems?.length) {
      cleaned.subItems = section.subItems.map(
        (subItem) => ({
          label: subItem.label,
          ...(subItem.hint
            ? { hint: subItem.hint }
            : {}),
          url: subItem.url,
        }),
      )
    }

    return cleaned
  })
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

function main() {
  const descriptor = parseVueFile(inputPath)

  // Route YAML
  const metadata = extractMetadata(descriptor)

  // TypeScript <script setup>
  const ast = parseScriptSetup(descriptor)

  // Extract sections
  const scriptSections = extractSections(ast)
  const rawSections = scriptSections.length > 0
    ? scriptSections
    : extractTemplateSections(descriptor)

  // Remove UI-only data such as colors
  const sections = cleanSections(rawSections)

  const output = {
    id: "tech/tpp-standards",

    source: {
      file: inputPath,
      parser: "vue-sfc",
    },

    metadata,

    sections,
  }

  fs.mkdirSync(path.dirname(outputPath), {
    recursive: true,
  })

  fs.writeFileSync(
    outputPath,
    `${JSON.stringify(output, null, 2)}\n`,
  )

  console.log(`Wrote ${outputPath}`)

  console.dir(output, {
    depth: null,
  })
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
