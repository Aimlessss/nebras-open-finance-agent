const fs = require("node:fs")
const path = require("node:path")
const { finalizeChunks } = require("./chunk-contract")

const inputPath = path.resolve(process.argv[2])

const defaultOutput = inputPath.replace(
  /\.json$/,
  ".chunks.json",
)

const outputPath = path.resolve(
  process.argv[3] || defaultOutput,
)

// ---------------------------------------------------------
// Helpers
// ---------------------------------------------------------

function cleanText(text) {
  return String(text || "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function slugify(text) {
  return cleanText(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function makeChunkId(
  documentId,
  parts,
  index,
) {
  const suffix = parts
    .filter(Boolean)
    .map(slugify)
    .filter(Boolean)
    .join("--")

  return [
    documentId,
    suffix || "content",
    index,
  ].join("#")
}

// ---------------------------------------------------------
// Block -> text
// ---------------------------------------------------------

function paragraphToText(block) {
  return cleanText(block.text)
}

function listToText(block) {
  const items = block.items ?? []

  return items
    .map((item) => `- ${cleanText(item)}`)
    .join("\n")
}

function orderedListToText(block) {
  const items = block.items ?? []

  return items
    .map(
      (item, index) =>
        `${index + 1}. ${cleanText(item)}`,
    )
    .join("\n")
}

function tableToText(block) {
  const headers = block.headers ?? []
  const rows = block.rows ?? []

  const lines = []

  if (headers.length > 0) {
    lines.push(headers.join(" | "))
  }

  for (const row of rows) {
    lines.push(
      row
        .map(cleanText)
        .join(" | "),
    )
  }

  return lines.join("\n")
}

function codeToText(block) {
  return cleanText(block.text)
}

function blockToText(block) {
  if (!block) {
    return ""
  }

  switch (block.type) {
    case "paragraph":
      return paragraphToText(block)

    case "list":
      return listToText(block)

    case "ordered_list":
      return orderedListToText(block)

    case "table":
      return tableToText(block)

    case "code":
      return codeToText(block)

    default:
      return ""
  }
}

function blocksToText(blocks = []) {
  return blocks
    .map(blockToText)
    .filter(Boolean)
    .join("\n\n")
}

// ---------------------------------------------------------
// Chunk builder
// ---------------------------------------------------------

function buildChunk({
  document,
  section,
  subsection,
  text,
  chunkIndex,
  type,
}) {
  const title =
    document.content?.title ||
    document.metadata?.title ||
    document.id

  const breadcrumb = [
    title,
    section?.category,
    section?.heading,
    subsection?.heading,
  ].filter(Boolean)

  const body = cleanText(text)

  const embeddingText = [
    breadcrumb.join(" > "),
    body,
  ]
    .filter(Boolean)
    .join("\n\n")

  return {
    id: makeChunkId(
      document.id,
      breadcrumb,
      chunkIndex,
    ),

    document_id: document.id,

    type,

    text: embeddingText,

    metadata: {
      title,

      ...(section?.heading
        ? {
            section:
              section.heading,
          }
        : {}),

      ...(section?.category
        ? {
            category:
              section.category,
          }
        : {}),

      ...(subsection?.heading
        ? {
            subsection:
              subsection.heading,
          }
        : {}),

      ...((subsection?.anchor || section?.anchor)
        ? {
            anchor:
              subsection?.anchor || section.anchor,
          }
        : {}),

      source_repo:
        document.source?.repo,

      source_file:
        document.source?.file,

      parser:
        document.source?.parser,
    },
  }
}

// ---------------------------------------------------------
// Navigation chunks
// ---------------------------------------------------------

function navigationToChunks(
  document,
  startIndex,
) {
  const chunks = []

  let index = startIndex

  for (
    const item
    of document.navigation ?? []
  ) {
    const lines = [
      item.title,
      item.description,
    ].filter(Boolean)

    if (
      item.tags?.length
    ) {
      lines.push(
        `Tags: ${item.tags.join(", ")}`,
      )
    }

    if (
      item.subItems?.length
    ) {
      for (
        const sub
        of item.subItems
      ) {
        lines.push(
          [
            sub.label,
            sub.hint,
          ]
            .filter(Boolean)
            .join(": "),
        )
      }
    }

    const body =
      lines.join("\n")

    if (!cleanText(body)) {
      continue
    }

    chunks.push({
      id: makeChunkId(
        document.id,
        [
          "navigation",
          item.title,
        ],
        index,
      ),

      document_id:
        document.id,

      type: "navigation",

      text: [
        document.content?.title ||
          document.metadata?.title ||
          document.id,

        item.category,

        body,
      ]
        .filter(Boolean)
        .join("\n\n"),

      metadata: {
        title:
          document.content?.title ||
          document.metadata?.title ||
          document.id,

        category:
          item.category,

        navigation_title:
          item.title,

        url:
          item.url,

        source_repo:
          document.source?.repo,

        source_file:
          document.source?.file,
      },
    })

    index++
  }

  return {
    chunks,
    nextIndex: index,
  }
}

// ---------------------------------------------------------
// Main chunking logic
// ---------------------------------------------------------

function chunkDocument(document) {
  const chunks = []

  let chunkIndex = 0

  // -------------------------------------------------------
  // Intro
  // -------------------------------------------------------

  const introText =
    blocksToText(
      document.content?.intro,
    )

  if (introText) {
    chunks.push(
      buildChunk({
        document,
        text: introText,
        chunkIndex,
        type: "intro",
      }),
    )

    chunkIndex++
  }

  // -------------------------------------------------------
  // Sections
  // -------------------------------------------------------

  for (
    const section
    of document.content
      ?.sections ?? []
  ) {
    // Section-level blocks
    const sectionText =
      blocksToText(
        section.blocks,
      )

    if (sectionText) {
      chunks.push(
        buildChunk({
          document,
          section,
          text: sectionText,
          chunkIndex,
          type: "section",
        }),
      )

      chunkIndex++
    }

    // Subsections
    for (
      const subsection
      of section.subsections ??
      []
    ) {
      const subsectionText =
        blocksToText(
          subsection.blocks,
        )

      if (
        !subsectionText
      ) {
        continue
      }

      chunks.push(
        buildChunk({
          document,
          section,
          subsection,
          text: subsectionText,
          chunkIndex,
          type:
            "subsection",
        }),
      )

      chunkIndex++
    }
  }

  // -------------------------------------------------------
  // Navigation
  // -------------------------------------------------------

  const navigationResult =
    navigationToChunks(
      document,
      chunkIndex,
    )

  chunks.push(
    ...navigationResult.chunks,
  )

  return finalizeChunks(document, chunks)
}

// ---------------------------------------------------------
// Run
// ---------------------------------------------------------

function main() {
  if (!process.argv[2]) {
    throw new Error(
      "Usage: node chunker.js <input.json> [output.json]",
    )
  }

  const raw =
    fs.readFileSync(
      inputPath,
      "utf8",
    )

  const document =
    JSON.parse(raw)

  const chunks =
    chunkDocument(
      document,
    )

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
      {
        document_id:
          document.id,

        chunk_count:
          chunks.length,

        chunks,
      },
      null,
      2,
    )}\n`,
  )

  console.log(
    `Wrote ${outputPath}`,
  )

  console.log(
    `Chunks: ${chunks.length}`,
  )
}

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
