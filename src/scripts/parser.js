const fs = require("node:fs")
const path = require("node:path")
const { execFileSync } = require("node:child_process")
const { extractOpenApi } = require("./openapi-extractor")
const { extractStructured } = require("./structured-extractor")
const { PARSER_VERSION, hashText, pageUrl } = require("./chunk-contract")

const { parse: parseVue } = require("@vue/compiler-sfc")
const { parse: parseTemplate } = require("@vue/compiler-dom")
const babelParser = require("@babel/parser")
const YAML = require("yaml")

// ---------------------------------------------------------
// Paths
// ---------------------------------------------------------

const agentRoot = path.resolve(__dirname, "../..")

const communityRepoRoot = path.resolve(
  agentRoot,
  process.env.SOURCE_ROOT || "../community-standards",
)

const defaultInput = path.resolve(
  communityRepoRoot,
  "src/pages/tech/tpp-standards/registration/api-guide.vue"

)

const defaultOutput = path.resolve(
  agentRoot,
  "output/tpp-standards/tpp-standards-main-app-registration.json",
)

const inputPath = path.resolve(
  process.argv[2] || defaultInput,
)

const outputPath = path.resolve(
  process.argv[3] || defaultOutput,
)

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

  // Ignore decorative symbols
  if (/^[→←↑↓•·›»‹«\-–—]+$/.test(cleaned)) {
    return false
  }

  return true
}

// ---------------------------------------------------------
// Vue SFC parser
// ---------------------------------------------------------

function parseVueFile(filePath) {
  const source = fs.readFileSync(
    filePath,
    "utf8",
  )

  const {
    descriptor,
    errors,
  } = parseVue(source, {
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
  const routeBlock =
    descriptor.customBlocks.find(
      (block) =>
        block.type === "route",
    )

  if (!routeBlock) {
    return {}
  }

  const route = YAML.parse(
    routeBlock.content,
  )

  return route?.meta ?? {}
}

// ---------------------------------------------------------
// Script setup
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
// Babel AST -> JS values
// ---------------------------------------------------------

function astToValue(node) {
  if (!node) {
    return null
  }

  switch (node.type) {
    case "StringLiteral":
      return cleanText(
        node.value,
      )

    case "NumericLiteral":
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

      for (
        const property of node.properties
      ) {
        if (
          property.type !==
          "ObjectProperty"
        ) {
          continue
        }

        let key

        if (
          property.key.type ===
          "Identifier"
        ) {
          key = property.key.name
        } else if (
          property.key.type ===
          "StringLiteral"
        ) {
          key = property.key.value
        } else {
          continue
        }

        result[key] =
          astToValue(
            property.value,
          )
      }

      return result
    }

    case "TemplateLiteral":
      return templateLiteralToString(
        node,
      )

    case "Identifier":
      if (
        node.name ===
        "undefined"
      ) {
        return undefined
      }

      return node.name

    default:
      return null
  }
}

function templateLiteralToString(
  node,
) {
  let result = ""

  for (
    let i = 0;
    i < node.quasis.length;
    i++
  ) {
    result +=
      node.quasis[i]
        .value.cooked ?? ""

    if (
      i <
      node.expressions.length
    ) {
      result +=
        expressionToString(
          node.expressions[i],
        )
    }
  }

  return cleanText(result)
}

function expressionToString(
  node,
) {
  if (
    node.type ===
    "MemberExpression"
  ) {
    const objectName =
      node.object.type ===
      "Identifier"
        ? node.object.name
        : null

    const propertyName =
      node.property.type ===
      "Identifier"
        ? node.property.name
        : null

    if (
      objectName ===
        "selectedVersion" &&
      propertyName === "value"
    ) {
      return "{version}"
    }
  }

  if (
    node.type ===
      "Identifier" &&
    node.name ===
      "selectedVersion"
  ) {
    return "{version}"
  }

  return "{dynamic}"
}

// ---------------------------------------------------------
// Extract script-defined sections/navigation
// ---------------------------------------------------------

function extractScriptSections(
  ast,
) {
  if (!ast) {
    return []
  }

  for (
    const node of ast.program.body
  ) {
    if (
      node.type !==
      "VariableDeclaration"
    ) {
      continue
    }

    for (
      const declaration
      of node.declarations
    ) {
      if (
        declaration.id.type !==
          "Identifier" ||
        declaration.id.name !==
          "sections"
      ) {
        continue
      }

      const init =
        declaration.init

      if (
        !init ||
        init.type !==
          "CallExpression"
      ) {
        continue
      }

      const callback =
        init.arguments[0]

      if (
        !callback ||
        callback.type !==
          "ArrowFunctionExpression"
      ) {
        continue
      }

      let arrayNode =
        callback.body

      if (
        arrayNode.type ===
        "BlockStatement"
      ) {
        const returnStatement =
          arrayNode.body.find(
            (statement) =>
              statement.type ===
              "ReturnStatement",
          )

        arrayNode =
          returnStatement
            ?.argument
      }

      if (
        !arrayNode ||
        arrayNode.type !==
          "ArrayExpression"
      ) {
        return []
      }

      return (
        astToValue(
          arrayNode,
        ) ?? []
      )
    }
  }

  return []
}

function cleanScriptNavigation(
  sections,
) {
  return sections.map(
    (section) => {
      const result = {}

      if (
        section.category
      ) {
        result.category =
          cleanText(
            section.category,
          )
      }

      if (section.title) {
        result.title =
          cleanText(
            section.title,
          )
      }

      if (section.url) {
        result.url =
          section.url
      }

      if (section.desc) {
        result.description =
          cleanText(
            section.desc,
          )
      }

      if (
        section.tags?.length
      ) {
        result.tags =
          section.tags
            .map(cleanText)
            .filter(
              isMeaningfulText,
            )
      }

      if (
        section
          .subItems
          ?.length
      ) {
        result.subItems =
          section.subItems
            .map((item) => ({
              label:
                cleanText(
                  item.label,
                ),

              ...(item.hint
                ? {
                    hint:
                      cleanText(
                        item.hint,
                      ),
                  }
                : {}),

              url: item.url,
            }))
            .filter(
              (item) =>
                isMeaningfulText(
                  item.label,
                ),
            )
      }

      return result
    },
  )
}

// ---------------------------------------------------------
// Template AST helpers
// ---------------------------------------------------------

function getNodeText(node) {
  if (!node) {
    return ""
  }

  if (node.type === 2) {
    return node.content
  }

  // {{ interpolation }}
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

// Only direct text children.
// Useful for H1 so "2 min read" isn't included.
function getDirectNodeText(
  node,
) {
  if (!node?.children) {
    return ""
  }

  return node.children
    .filter(
      (child) =>
        child.type === 2,
    )
    .map(
      (child) =>
        child.content,
    )
    .join(" ")
}

function getAttribute(
  node,
  name,
) {
  if (!node?.props) {
    return undefined
  }

  const prop =
    node.props.find(
      (item) =>
        item.type === 6 &&
        item.name === name,
    )

  return (
    prop?.value
      ?.content
  )
}

function getClassList(node) {
  const className =
    getAttribute(
      node,
      "class",
    )

  if (!className) {
    return []
  }

  return className
    .split(/\s+/)
    .filter(Boolean)
}

function hasClass(
  node,
  className,
) {
  return getClassList(
    node,
  ).includes(
    className,
  )
}

// ---------------------------------------------------------
// Descendant helpers
// ---------------------------------------------------------

function findDescendants(
  node,
  predicate,
) {
  const found = []

  function walk(current) {
    if (!current) {
      return
    }

    if (
      predicate(current)
    ) {
      found.push(
        current,
      )
    }

    for (
      const child
      of current.children ??
        []
    ) {
      walk(child)
    }
  }

  walk(node)

  return found
}

function findFirstDescendant(
  node,
  predicate,
) {
  return findDescendants(
    node,
    predicate,
  )[0]
}

function findDescendantsByTag(
  node,
  tagName,
) {
  const wanted =
    tagName.toLowerCase()

  return findDescendants(
    node,
    (current) =>
      current.type === 1 &&
      current.tag
        ?.toLowerCase() ===
        wanted,
  )
}

// ---------------------------------------------------------
// Lists
// ---------------------------------------------------------

function extractList(node) {
  return findDescendantsByTag(
    node,
    "li",
  )
    .map((item) =>
      cleanText(
        getNodeText(item),
      ),
    )
    .filter(
      isMeaningfulText,
    )
}

// ---------------------------------------------------------
// Tables
// ---------------------------------------------------------

function extractTable(node) {
  const headers =
    findDescendantsByTag(
      node,
      "th",
    )
      .map((header) =>
        cleanText(
          getNodeText(
            header,
          ),
        ),
      )
      .filter(
        isMeaningfulText,
      )

  const rows = []

  for (
    const row
    of findDescendantsByTag(
      node,
      "tr",
    )
  ) {
    const cells =
      (row.children ?? [])
        .filter(
          (child) =>
            child.type ===
              1 &&
            child.tag
              ?.toLowerCase() ===
              "td",
        )
        .map((cell) =>
          cleanText(
            getNodeText(
              cell,
            ),
          ),
        )

    if (
      cells.some(
        isMeaningfulText,
      )
    ) {
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
// Code
// ---------------------------------------------------------

function extractCode(node) {
  const text = cleanText(
    getNodeText(node),
  )

  if (
    !isMeaningfulText(
      text,
    )
  ) {
    return null
  }

  return {
    type: "code",
    text,
  }
}

// ---------------------------------------------------------
// Template navigation cards
// ---------------------------------------------------------

function extractTemplateNavigation(
  container,
) {
  const cards =
    findDescendants(
      container,
      (node) =>
        node.type === 1 &&
        node.tag
          ?.toLowerCase() ===
          "a" &&
        hasClass(
          node,
          "ed-link-card",
        ),
    )

  return cards
    .map((card) => {
      const titleNode =
        findFirstDescendant(
          card,
          (node) =>
            node.type ===
              1 &&
            [
              "h2",
              "h3",
              "h4",
            ].includes(
              node.tag
                ?.toLowerCase(),
            ),
        )

      const descriptionNode =
        findFirstDescendant(
          card,
          (node) =>
            node.type ===
              1 &&
            node.tag
              ?.toLowerCase() ===
              "p",
        )

      const categoryNode =
        findFirstDescendant(
          card,
          (node) =>
            node.type ===
              1 &&
            hasClass(
              node,
              "ed-link-card__cat",
            ),
        )

      const title =
        cleanText(
          getNodeText(
            titleNode,
          ),
        )

      if (
        !isMeaningfulText(
          title,
        )
      ) {
        return null
      }

      return {
        ...(categoryNode
          ? {
              category:
                cleanText(
                  getNodeText(
                    categoryNode,
                  ),
                ),
            }
          : {}),

        title,

        ...(getAttribute(
          card,
          "href",
        )
          ? {
              url:
                getAttribute(
                  card,
                  "href",
                ),
            }
          : {}),

        ...(descriptionNode
          ? {
              description:
                cleanText(
                  getNodeText(
                    descriptionNode,
                  ),
                ),
            }
          : {}),
      }
    })
    .filter(Boolean)
}

// ---------------------------------------------------------
// Template -> canonical document
// ---------------------------------------------------------

function extractTemplateStructure(
  descriptor,
) {
  if (
    !descriptor
      .template
      ?.content
  ) {
    return {
      title: undefined,
      intro: [],
      sections: [],
      navigation: [],
    }
  }

  const ast =
    parseTemplate(
      descriptor
        .template
        .content,
    )

  const document = {
    title: undefined,
    intro: [],
    sections: [],
    navigation: [],
  }

  let currentSection =
    null

  let currentSubsection =
    null

  function addBlock(block) {
    if (!block) {
      return
    }

    if (
      currentSubsection
    ) {
      currentSubsection
        .blocks
        .push(block)

      return
    }

    if (
      currentSection
    ) {
      currentSection
        .blocks
        .push(block)

      return
    }

    document.intro
      .push(block)
  }

  function walk(node) {
    if (!node) {
      return
    }

    if (node.type === 1) {
      const tag =
        node.tag
          ?.toLowerCase()

      // ---------------------------------------------------
      // Navigation section
      // ---------------------------------------------------

      if (
        tag === "section" &&
        hasClass(
          node,
          "ed-doc__contents",
        )
      ) {
        document.navigation.push(
          ...extractTemplateNavigation(
            node,
          ),
        )

        return
      }

      // ---------------------------------------------------
      // Custom docs section:
      // <EdSectionBand>
      // ---------------------------------------------------

      if (
        tag ===
        "edsectionband"
      ) {
        const previousSection =
          currentSection

        const previousSubsection =
          currentSubsection

        const heading =
          cleanText(
            getAttribute(
              node,
              "title",
            ) || "",
          )

        const category =
          cleanText(
            getAttribute(
              node,
              "eyebrow",
            ) || "",
          )

        currentSection = {
          heading:
            heading ||
            category ||
            "Untitled section",

          level: 2,

          anchor:
            getAttribute(
              node,
              "id",
            ) ?? null,

          ...(category
            ? {
                category,
              }
            : {}),

          blocks: [],

          subsections: [],
        }

        document.sections.push(
          currentSection,
        )

        currentSubsection =
          null

        for (
          const child
          of node.children ??
            []
        ) {
          walk(child)
        }

        currentSection =
          previousSection

        currentSubsection =
          previousSubsection

        return
      }

      // ---------------------------------------------------
      // H1
      // ---------------------------------------------------

      if (tag === "h1") {
        const directText =
          cleanText(
            getDirectNodeText(
              node,
            ),
          )

        const fallbackText =
          cleanText(
            getNodeText(
              node,
            ),
          )

        const text =
          directText ||
          fallbackText

        if (
          isMeaningfulText(
            text,
          )
        ) {
          document.title =
            text
        }

        return
      }

      // ---------------------------------------------------
      // H2
      // ---------------------------------------------------

      if (tag === "h2") {
        const text =
          cleanText(
            getNodeText(
              node,
            ),
          )

        if (
          isMeaningfulText(
            text,
          )
        ) {
          currentSection = {
            heading: text,
            level: 2,

            anchor:
              getAttribute(
                node,
                "id",
              ) ?? null,

            blocks: [],

            subsections: [],
          }

          document.sections.push(
            currentSection,
          )

          currentSubsection =
            null
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
        const text =
          cleanText(
            getNodeText(
              node,
            ),
          )

        if (
          isMeaningfulText(
            text,
          ) &&
          currentSection
        ) {
          currentSubsection = {
            heading: text,

            level:
              Number(
                tag.slice(1),
              ),

            anchor:
              getAttribute(
                node,
                "id",
              ) ?? null,

            blocks: [],
          }

          currentSection
            .subsections
            .push(
              currentSubsection,
            )
        }

        return
      }

      // ---------------------------------------------------
      // EdProse
      // ---------------------------------------------------

      if (
        tag === "edprose"
      ) {
        const text =
          cleanText(
            getNodeText(
              node,
            ),
          )

        if (
          isMeaningfulText(
            text,
          )
        ) {
          addBlock({
            type:
              "paragraph",
            text,
          })
        }

        return
      }

      // ---------------------------------------------------
      // EdBullets
      // ---------------------------------------------------

      if (
        tag ===
        "edbullets"
      ) {
        const items =
          extractList(
            node,
          )

        if (
          items.length > 0
        ) {
          addBlock({
            type: "list",
            items,
          })
        }

        return
      }

      // ---------------------------------------------------
      // Native paragraph
      // ---------------------------------------------------

      if (tag === "p") {
        const text =
          cleanText(
            getNodeText(
              node,
            ),
          )

        if (
          isMeaningfulText(
            text,
          )
        ) {
          addBlock({
            type:
              "paragraph",
            text,
          })
        }

        return
      }

      // ---------------------------------------------------
      // Native lists
      // ---------------------------------------------------

      if (
        tag === "ul" ||
        tag === "ol"
      ) {
        const items =
          extractList(
            node,
          )

        if (
          items.length > 0
        ) {
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

      if (
        tag === "table"
      ) {
        const table =
          extractTable(
            node,
          )

        if (
          table.headers
            .length >
            0 ||
          table.rows
            .length >
            0
        ) {
          addBlock(
            table,
          )
        }

        return
      }

      // ---------------------------------------------------
      // Code
      // ---------------------------------------------------

      if (
        tag === "pre"
      ) {
        addBlock(
          extractCode(
            node,
          ),
        )

        return
      }
    }

    for (
      const child
      of node.children ??
        []
    ) {
      walk(child)
    }
  }

  walk(ast)

  return document
}

// ---------------------------------------------------------
// IDs + relative paths
// ---------------------------------------------------------

function getRelativeSourcePath(
  filePath,
) {
  return path
    .relative(
      communityRepoRoot,
      filePath,
    )
    .replace(
      /\\/g,
      "/",
    )
}

function createDocumentId(
  filePath,
) {
  let relative =
    getRelativeSourcePath(
      filePath,
    )

  relative =
    relative.replace(
      /^src\/pages\//,
      "",
    )

  relative =
    relative.replace(
      /\/index\.vue$/,
      "",
    )

  relative =
    relative.replace(
      /\.vue$/,
      "",
    )

  return relative
}

// ---------------------------------------------------------
// Merge navigation
// ---------------------------------------------------------

function mergeNavigation(
  ...groups
) {
  const result = []
  const seen =
    new Set()

  for (
    const group
    of groups
  ) {
    for (
      const item
      of group ?? []
    ) {
      const key =
        item.url ||
        `${item.category || ""}:${item.title || ""}`

      if (
        !key ||
        seen.has(key)
      ) {
        continue
      }

      seen.add(key)
      result.push(item)
    }
  }

  return result
}

// ---------------------------------------------------------
// Main
// ---------------------------------------------------------

function main() {
  const descriptor =
    parseVueFile(
      inputPath,
    )

  const metadata =
    extractMetadata(
      descriptor,
    )

  const scriptAst =
    parseScriptSetup(
      descriptor,
    )

  const scriptNavigation =
    cleanScriptNavigation(
      extractScriptSections(
        scriptAst,
      ),
    )

  const template =
    extractTemplateStructure(
      descriptor,
    )

  const navigation =
    mergeNavigation(
      scriptNavigation,
      template.navigation,
    )

  let content = {
    title:
      metadata.title ||
      template.title,

    intro:
      template.intro,

    sections:
      template.sections,
  }

  const structured = extractStructured(descriptor, communityRepoRoot, createDocumentId(inputPath).match(/(?:^|\/)(v\d+\.[^/]+)(?:\/|$)/)?.[1])
  if (structured.content) content = structured.content
  const extractedApi = extractOpenApi(descriptor.template?.content, communityRepoRoot, descriptor.scriptSetup?.content)
  content.sections.push(...extractedApi.sections)
  const sourceText = fs.readFileSync(inputPath, "utf8")
  let commit = process.env.SOURCE_COMMIT || null
  if (!commit) {
    try { commit = execFileSync("git", ["-C", communityRepoRoot, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() } catch {}
  }
  const dependencies = [...extractedApi.dependencies, ...structured.dependencies]
  const warnings = []
  // Record import specifiers; resolution/transitive dependency tracking belongs to the engine.
  for (const match of sourceText.matchAll(/(?:from\s*|import\s*\()(['"])([^'"]+)\1/g)) dependencies.push(match[2])
  if (dependencies.length || /\{\{|v-for|:[a-zA-Z]/.test(sourceText)) warnings.push("Static extraction may omit imported or dynamic content; review before indexing.")
  const documentId = createDocumentId(inputPath)
  const url = pageUrl(documentId)
  if (!url) warnings.push("Generated or excluded route requires explicit URL resolution.")
  const output = {
    id:
      createDocumentId(
        inputPath,
      ),

    source: {
      repo:
        "community-standards",

      file:
        getRelativeSourcePath(
          inputPath,
        ),

      parser: "vue-sfc",
      parser_version: PARSER_VERSION,
      commit,
      hash: hashText(sourceText),
      dependencies: [...new Set(dependencies)].sort(),
      assets: [...extractedApi.assets, ...structured.assets],
      extraction_warnings: warnings,
    },

    metadata: { ...metadata, url, doc_version: documentId.match(/(?:^|\/)(v\d+\.[^/]+)(?:\/|$)/)?.[1] || "unversioned" },

    content,

    ...(navigation.length >
    0
      ? {
          navigation,
        }
      : {}),
  }

  fs.mkdirSync(
    path.dirname(
      outputPath,
    ),
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
    JSON.stringify(
      output,
      null,
      2,
    ),
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