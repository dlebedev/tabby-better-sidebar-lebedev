import { parseFragment, serializeOuter } from 'parse5'
import type { DefaultTreeAdapterTypes, ParserError } from 'parse5'
import { LineCounter, parseAllDocuments } from 'yaml'

/** Text formats the built-in editor can currently validate and format. */
export type TextDocumentFormat = 'json'|'yaml'|'ini'|'xml'|'html'

/** Syntax issue positions are counted from 1, following editor convention. */
export interface TextDocumentIssue {
    line: number
    column: number
    message: string
}

const HTML_VOID_ELEMENTS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const HTML_OPTIONAL_END_TAGS = new Set(['html', 'head', 'body', 'li', 'dt', 'dd', 'p', 'rt', 'rp', 'optgroup', 'option', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])
const HTML_BLOCK_ELEMENTS = new Set(['html', 'head', 'body', 'main', 'header', 'footer', 'nav', 'section', 'article', 'aside', 'div', 'form', 'fieldset', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'ul', 'ol', 'dl', 'li', 'blockquote', 'details', 'summary', 'figure', 'figcaption'])
const HTML_RAW_TEXT_ELEMENTS = new Set(['script', 'style', 'pre', 'textarea'])

/** Detect the format from the file extension; unknown types stay plain text. */
export function detectTextDocumentFormat (fileName: string): TextDocumentFormat|null {
    const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
    switch (extension) {
        case 'json':
            return 'json'
        case 'yaml':
        case 'yml':
            return 'yaml'
        case 'ini':
        case 'cfg':
            return 'ini'
        case 'xml':
        case 'svg':
            return 'xml'
        case 'html':
        case 'htm':
            return 'html'
        default:
            return null
    }
}

/** Validate the given format and return issues that can be located. */
export function validateTextDocument (format: TextDocumentFormat, text: string): TextDocumentIssue[] {
    switch (format) {
        case 'json':
            return validateJson(text)
        case 'yaml':
            return validateYaml(text)
        case 'ini':
            return validateIni(text)
        case 'xml':
            return validateXml(text)
        case 'html':
            return validateHtml(text)
    }
}

/** Validate first, then format, so a parse result never overwrites an invalid document. */
export function formatTextDocument (format: TextDocumentFormat, text: string): string {
    const issues = validateTextDocument(format, text)
    if (issues.length) {
        throw new Error('Formatting is unavailable while syntax errors are present.')
    }

    switch (format) {
        case 'json':
            return `${JSON.stringify(JSON.parse(text), null, 2)}\n`
        case 'yaml':
            return formatYaml(text)
        case 'ini':
            return formatIni(text)
        case 'xml':
            return formatXml(text)
        case 'html':
            return formatHtml(text)
    }
}

/** Convert a character offset into a user-readable line and column. */
function positionAt (text: string, offset: number): { line: number, column: number } {
    let line = 1
    let column = 1
    const end = Math.max(0, Math.min(text.length, offset))
    for (let index = 0; index < end; index++) {
        if (text[index] === '\n') {
            line++
            column = 1
        } else if (text[index] !== '\r') {
            column++
        }
    }
    return { line, column }
}

/** Locate the first invalid character using the native JSON parser. */
function validateJson (text: string): TextDocumentIssue[] {
    try {
        JSON.parse(text)
        return []
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const offset = Number(message.match(/position\s+(\d+)/i)?.[1] ?? text.length)
        return [{ ...positionAt(text, offset), message }]
    }
}

/** YAML errors carry source positions; comments and multi-document streams are kept for formatting. */
function validateYaml (text: string): TextDocumentIssue[] {
    const lineCounter = new LineCounter()
    try {
        const documents = parseAllDocuments(text, {
            lineCounter,
            prettyErrors: false,
            strict: true,
            logLevel: 'error',
        })
        return documents.flatMap(document => document.errors.map(error => {
            const position = error.linePos?.[0]
                ?? lineCounter.linePos(error.pos?.[0] ?? 0)
            return { line: position.line, column: position.col, message: error.message }
        }))
    } catch (error) {
        return [{ line: 1, column: 1, message: error instanceof Error ? error.message : String(error) }]
    }
}

/** Check common INI sections, key/value lines and quote closure. */
function validateIni (text: string): TextDocumentIssue[] {
    const issues: TextDocumentIssue[] = []
    const lines = text.split(/\r\n|\n|\r/)
    lines.forEach((rawLine, index) => {
        const line = rawLine.trim()
        if (!line || line.startsWith(';') || line.startsWith('#')) {
            return
        }

        if (line.startsWith('[') || line.endsWith(']')) {
            if (!/^\[[^\]\r\n]+\](?:\s*[;#].*)?$/.test(line)) {
                issues.push({ line: index + 1, column: Math.max(1, rawLine.indexOf('[') + 1), message: 'Invalid INI section header.' })
            }
            return
        }

        const delimiter = Math.min(...['=', ':'].map(value => {
            const position = line.indexOf(value)
            return position < 0 ? Number.MAX_SAFE_INTEGER : position
        }))
        if (delimiter === Number.MAX_SAFE_INTEGER || !line.slice(0, delimiter).trim()) {
            issues.push({ line: index + 1, column: Math.max(1, rawLine.search(/\S/) + 1), message: 'Expected an INI key=value entry.' })
        }
    })
    return issues
}

/** Check that the XML is well-formed and extract error positions from the browser parser output. */
function validateXml (text: string): TextDocumentIssue[] {
    try {
        const document = new DOMParser().parseFromString(text, 'application/xml')
        const parserError = document.getElementsByTagNameNS('*', 'parsererror').item(0)
            ?? (document.documentElement?.localName === 'parsererror' ? document.documentElement : null)
        if (!parserError) {
            return []
        }
        const detail = parserError.textContent?.trim().split(/\r?\n/)[0] ?? 'Invalid XML document.'
        const position = detail.match(/(?:line|ligne|zeile|行)\s*(?:number\s*)?(\d+)(?:\s*(?:at\s*)?(?:column|col|spalte|列)\s*(\d+))?/i)
        return [{
            line: Number(position?.[1] ?? 1),
            column: Number(position?.[2] ?? 1),
            message: detail.replace(/^.*?:\s*/, '') || 'Invalid XML document.',
        }]
    } catch (error) {
        const locator = (error as Error & { locator?: { lineNumber?: number, columnNumber?: number } }).locator
        return [{
            line: locator?.lineNumber ?? 1,
            column: locator?.columnNumber ?? 1,
            message: error instanceof Error ? error.message : String(error),
        }]
    }
}

/** Collect both HTML parse errors and missing required end tags. */
function validateHtml (text: string): TextDocumentIssue[] {
    const parserErrors: ParserError[] = []
    const fragment = parseFragment(text, {
        sourceCodeLocationInfo: true,
        onParseError: error => parserErrors.push(error),
    })
    const issues: TextDocumentIssue[] = parserErrors.map(error => ({
        line: error.startLine,
        column: error.startCol,
        message: `HTML parser error: ${error.code}`,
    }))
    collectUnclosedHtmlElements(fragment.childNodes, text, issues)
    return uniqueIssues(issues)
}

/** HTML allows a few tags to omit their end tag; other unclosed elements must be reported explicitly. */
function collectUnclosedHtmlElements (nodes: DefaultTreeAdapterTypes.ChildNode[], text: string, issues: TextDocumentIssue[]): void {
    for (const node of nodes) {
        if (!('tagName' in node)) {
            continue
        }
        const element = node as DefaultTreeAdapterTypes.Element|DefaultTreeAdapterTypes.Template
        const location = element.sourceCodeLocation
        const name = element.tagName.toLowerCase()
        const isHtmlElement = element.namespaceURI === 'http://www.w3.org/1999/xhtml'
        const startTag = location?.startTag
            ? text.slice(location.startTag.startOffset, location.startTag.endOffset)
            : ''
        if (location?.startTag && !location.endTag && isHtmlElement
            && !HTML_VOID_ELEMENTS.has(name) && !HTML_OPTIONAL_END_TAGS.has(name)
            && !startTag.trimEnd().endsWith('/>')) {
            issues.push({
                line: location.startTag.startLine,
                column: location.startTag.startCol,
                message: `Unclosed <${name}> element.`,
            })
        }

        const children = 'content' in element ? element.content.childNodes : element.childNodes
        collectUnclosedHtmlElements(children, text, issues)
    }
}

/** Drop duplicate HTML diagnostics at the same position. */
function uniqueIssues (issues: TextDocumentIssue[]): TextDocumentIssue[] {
    const seen = new Set<string>()
    return issues
        .sort((left, right) => left.line - right.line || left.column - right.column)
        .filter(issue => {
            const key = `${issue.line}:${issue.column}:${issue.message}`
            if (seen.has(key)) {
                return false
            }
            seen.add(key)
            return true
        })
}

/** Re-indent valid YAML document streams uniformly while preserving comments and node order the parser supports. */
function formatYaml (text: string): string {
    const documents = parseAllDocuments(text, { prettyErrors: false, strict: true, logLevel: 'error' })
    return documents.map(document => document.toString({ indent: 2 })).join('---\n')
}

/** Normalize INI key/value spacing and blank lines between sections, preserving comments and existing separators. */
function formatIni (text: string): string {
    const output: string[] = []
    for (const rawLine of text.split(/\r\n|\n|\r/)) {
        const line = rawLine.trim()
        if (!line) {
            if (output.length && output[output.length - 1] !== '') {
                output.push('')
            }
            continue
        }
        if (line.startsWith(';') || line.startsWith('#')) {
            output.push(line)
            continue
        }
        const section = line.match(/^\[([^\]]+)\](\s*[;#].*)?$/)
        if (section) {
            while (output[output.length - 1] === '') {
                output.pop()
            }
            if (output.length) {
                output.push('')
            }
            output.push(`[${section[1].trim()}]${section[2] ? ` ${section[2].trim()}` : ''}`)
            continue
        }
        const delimiterIndex = Math.min(
            ...['=', ':'].map(delimiter => {
                const position = line.indexOf(delimiter)
                return position < 0 ? Number.MAX_SAFE_INTEGER : position
            }),
        )
        const key = line.slice(0, delimiterIndex).trim()
        const delimiter = line[delimiterIndex]
        const value = line.slice(delimiterIndex + 1).trim()
        output.push(`${key} ${delimiter} ${value}`)
    }
    const formatted = output.join('\n').replace(/\n+$/, '')
    return formatted ? `${formatted}\n` : ''
}

/** Use the XML DOM to preserve mixed text, formatting only structural levels made up of elements. */
function formatXml (text: string): string {
    const document = new DOMParser().parseFromString(text, 'application/xml')
    const serializer = new XMLSerializer()
    const nodes = Array.from(document.childNodes).filter(node => !(node.nodeType === Node.TEXT_NODE && !node.textContent?.trim()))
    const declaration = text.match(/^\uFEFF?\s*(<\?xml\b[^?]*\?>)/i)?.[1]
    const body = nodes.map(node => formatXmlNode(node, serializer, 0)).join('\n')
    return `${declaration ? `${declaration}\n` : ''}${body}\n`
}

/** Recursively indent XML structural nodes, preserving mixed content that contains text or CDATA. */
function formatXmlNode (node: Node, serializer: XMLSerializer, depth: number): string {
    const indent = '  '.repeat(depth)
    if (node.nodeType !== Node.ELEMENT_NODE) {
        return `${indent}${serializer.serializeToString(node)}`
    }

    const element = node as Element
    const children = Array.from(element.childNodes)
    const hasMixedText = children.some(child =>
        (child.nodeType === Node.TEXT_NODE && !!child.textContent?.trim())
        || child.nodeType === Node.CDATA_SECTION_NODE,
    )
    const structuralChildren = children.filter(child => !(child.nodeType === Node.TEXT_NODE && !child.textContent?.trim()))
    if (!structuralChildren.some(child => child.nodeType === Node.ELEMENT_NODE)
        || hasMixedText) {
        return `${indent}${serializer.serializeToString(element)}`
    }

    const opening = serializer.serializeToString(element.cloneNode(false))
    const closingIndex = opening.lastIndexOf('</')
    const rawOpening = closingIndex >= 0 ? opening.slice(0, closingIndex) : opening
    const openingTag = rawOpening.endsWith('/>') ? `${rawOpening.slice(0, -2)}>` : rawOpening
    const closingTag = `</${element.nodeName}>`
    return `${indent}${openingTag}\n${structuralChildren.map(child => formatXmlNode(child, serializer, depth + 1)).join('\n')}\n${indent}${closingTag}`
}

/** HTML layout only expands block-level structure, so inline text never gains extra whitespace. */
function formatHtml (text: string): string {
    const fragment = parseFragment(text, { sourceCodeLocationInfo: true })
    const formatted = formatHtmlNodes(fragment.childNodes, text, 0)
    return formatted ? `${formatted}\n` : ''
}

/** Lay out HTML nodes based on their original source locations, without rewriting tag attributes or text. */
function formatHtmlNodes (nodes: DefaultTreeAdapterTypes.ChildNode[], source: string, depth: number): string {
    return nodes
        .filter(node => !(node.nodeName === '#text' && !htmlNodeSource(node, source).trim()))
        .map(node => formatHtmlNode(node, source, depth))
        .join('\n')
}

/** Re-indent only safe block-level subtrees; all other nodes keep their original source. */
function formatHtmlNode (node: DefaultTreeAdapterTypes.ChildNode, source: string, depth: number): string {
    const indent = '  '.repeat(depth)
    if (!('tagName' in node)) {
        return `${indent}${htmlNodeSource(node, source)}`
    }

    const element = node as DefaultTreeAdapterTypes.Element|DefaultTreeAdapterTypes.Template
    const location = element.sourceCodeLocation
    if (!location?.startTag) {
        return `${indent}${serializeOuter(element)}`
    }

    const name = element.tagName.toLowerCase()
    const children = 'content' in element ? element.content.childNodes : element.childNodes
    const originalElement = source.slice(location.startOffset, location.endOffset)
    const hasTextContent = children.some(child => child.nodeName === '#text' && !!htmlNodeSource(child, source).trim())
    if (!HTML_BLOCK_ELEMENTS.has(name) || HTML_RAW_TEXT_ELEMENTS.has(name) || !children.length || hasTextContent) {
        return `${indent}${originalElement}`
    }

    const nested = formatHtmlNodes(children, source, depth + 1)
    if (!nested) {
        return `${indent}${originalElement}`
    }
    const startTag = source.slice(location.startTag.startOffset, location.startTag.endOffset)
    const endTag = location.endTag
        ? source.slice(location.endTag.startOffset, location.endTag.endOffset)
        : ''
    const trailing = endTag ? `\n${indent}${endTag}` : ''
    return `${indent}${startTag}\n${nested}${trailing}`
}

/** Read a node's original HTML slice so serialization cannot change entities or attribute quoting. */
function htmlNodeSource (node: DefaultTreeAdapterTypes.ChildNode, source: string): string {
    const location = node.sourceCodeLocation
    return location
        ? source.slice(location.startOffset, location.endOffset)
        : serializeOuter(node)
}
