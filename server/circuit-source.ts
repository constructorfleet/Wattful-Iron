import ts from "typescript"

export type PropValue = string | number | boolean

type Edit = { start: number; end: number; text: string }

const elementNamePattern = /^[a-z][a-z0-9]*$/
const propNamePattern = /^[a-zA-Z_][a-zA-Z0-9_]*$/
const componentNamePattern = /^[A-Za-z0-9_-]{1,64}$/
/** Elements that describe connections or annotations rather than placed components. */
const nonComponentElements = new Set(["trace", "net", "schematicsheet", "schematictext", "netlabel"])

/** Set or replace board-level properties such as dimensions and layer count. */
export function setBoardDimensions(source: string, dimensions: { width?: string; height?: string; layers?: number }): string {
  const props: Record<string, PropValue> = {}
  if (dimensions.width !== undefined) props.width = requireLength(dimensions.width, "width")
  if (dimensions.height !== undefined) props.height = requireLength(dimensions.height, "height")
  if (dimensions.layers !== undefined) props.layers = requireLayers(dimensions.layers)
  if (!Object.keys(props).length) throw new Error("Specify at least one of width, height, or layers")
  const file = parse(source)
  return applyEdits(source, propertyEdits(source, opening(findBoard(file)), props))
}

/** Set, replace, or remove properties on the component with the given name. */
export function setComponentProperties(source: string, name: string, props: Record<string, PropValue | null>): string {
  if (!Object.keys(props).length) throw new Error("Specify at least one property to set")
  const file = parse(source)
  const component = findComponent(findBoard(file), requireComponentName(name))
  return applyEdits(source, propertyEdits(source, opening(component), props))
}

/** Append a component element to the board. */
export function addComponent(source: string, component: { element: string; name: string; props?: Record<string, PropValue> }): string {
  const element = component.element.trim()
  if (!elementNamePattern.test(element)) throw new Error("Component element must be a lowercase tscircuit element name such as resistor")
  if (nonComponentElements.has(element)) throw new Error(`Use the dedicated tool for ${element} elements`)
  const name = requireComponentName(component.name)
  const file = parse(source)
  const board = findBoard(file)
  if (components(board).some((child) => componentName(child) === name)) throw new Error(`A component named ${name} already exists`)
  const props = { name, ...(component.props ?? {}) }
  const text = `<${element}${serializeProps(props)} />`
  return applyEdits(source, [insertChild(source, board, text, "component")])
}

/** Remove a component and every trace that references it. */
export function removeComponent(source: string, name: string): string {
  const componentNameValue = requireComponentName(name)
  const file = parse(source)
  const board = findBoard(file)
  const component = findComponent(board, componentNameValue)
  const edits = [removeLine(source, component)]
  for (const child of children(board)) {
    if (tagName(child) !== "trace") continue
    if (traceEndpoints(child).some((endpoint) => referencesComponent(endpoint, componentNameValue))) edits.push(removeLine(source, child))
  }
  return applyEdits(source, edits)
}

/** Connect two component ports with a trace. */
export function connectComponents(source: string, connection: { from: string; to: string; name?: string }): string {
  const from = requireSelector(connection.from, "from")
  const to = requireSelector(connection.to, "to")
  if (from === to) throw new Error("A trace must connect two different selectors")
  const file = parse(source)
  const board = findBoard(file)
  for (const selector of [from, to]) {
    const target = selectorComponent(selector)
    if (target && !components(board).some((child) => componentName(child) === target)) {
      throw new Error(`No component named ${target} exists in this circuit`)
    }
  }
  const existing = children(board).some((child) => {
    if (tagName(child) !== "trace") return false
    const endpoints = traceEndpoints(child)
    return endpoints.includes(from) && endpoints.includes(to)
  })
  if (existing) throw new Error(`A trace already connects ${from} to ${to}`)
  const props: Record<string, PropValue> = { from, to }
  if (connection.name !== undefined) props.name = requireComponentName(connection.name)
  return applyEdits(source, [insertChild(source, board, `<trace${serializeProps(props)} />`, "trace")])
}

/** List the component elements the board places, for tools that report circuit source structure. */
export function listSourceComponents(source: string): Array<{ element: string; name: string }> {
  const board = findBoard(parse(source))
  return components(board).flatMap((child) => {
    const name = componentName(child)
    return name ? [{ element: tagName(child) ?? "", name }] : []
  })
}

function parse(source: string) {
  return ts.createSourceFile("circuit.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
}

function findBoard(file: ts.SourceFile): ts.JsxElement | ts.JsxSelfClosingElement {
  const boards: Array<ts.JsxElement | ts.JsxSelfClosingElement> = []
  const visit = (node: ts.Node) => {
    if (ts.isJsxElement(node) && tagName(node) === "board") boards.push(node)
    if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(file) === "board") boards.push(node)
    ts.forEachChild(node, visit)
  }
  visit(file)
  if (!boards.length) throw new Error("This source does not contain a <board> element to edit")
  if (boards.length > 1) throw new Error("This source contains more than one <board> element, so it cannot be edited structurally")
  return boards[0]!
}

function opening(element: ts.JsxElement | ts.JsxSelfClosingElement) {
  return ts.isJsxElement(element) ? element.openingElement : element
}

function children(board: ts.JsxElement | ts.JsxSelfClosingElement): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
  if (!ts.isJsxElement(board)) return []
  return board.children.filter((child): child is ts.JsxElement | ts.JsxSelfClosingElement =>
    ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child))
}

function components(board: ts.JsxElement | ts.JsxSelfClosingElement) {
  return children(board).filter((child) => {
    const tag = tagName(child)
    return !!tag && !nonComponentElements.has(tag)
  })
}

function tagName(element: ts.Node): string | undefined {
  if (ts.isJsxElement(element)) return element.openingElement.tagName.getText()
  if (ts.isJsxSelfClosingElement(element)) return element.tagName.getText()
  return undefined
}

function findComponent(board: ts.JsxElement | ts.JsxSelfClosingElement, name: string) {
  const matches = components(board).filter((child) => componentName(child) === name)
  if (!matches.length) throw new Error(`No component named ${name} exists in this circuit`)
  if (matches.length > 1) throw new Error(`More than one component is named ${name}`)
  return matches[0]!
}

function componentName(element: ts.JsxElement | ts.JsxSelfClosingElement) {
  return stringAttribute(opening(element), "name")
}

function attribute(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  return element.attributes.properties.find((property): property is ts.JsxAttribute =>
    ts.isJsxAttribute(property) && property.name.getText() === name)
}

function stringAttribute(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, name: string) {
  const initializer = attribute(element, name)?.initializer
  if (!initializer) return undefined
  if (ts.isStringLiteral(initializer)) return initializer.text
  if (ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteral(initializer.expression)) return initializer.expression.text
  return undefined
}

function traceEndpoints(trace: ts.JsxElement | ts.JsxSelfClosingElement) {
  const element = opening(trace)
  return ["from", "to"].flatMap((name) => {
    const value = stringAttribute(element, name)
    return value ? [value] : []
  })
}

/** A selector such as `.R1 > .pin1` or `.R1` refers to the component named R1. */
function selectorComponent(selector: string) {
  const match = /^\.([A-Za-z0-9_-]+)/.exec(selector.trim())
  return match?.[1]
}

function referencesComponent(selector: string, name: string) {
  return selectorComponent(selector) === name
}

function propertyEdits(source: string, element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, props: Record<string, PropValue | null>): Edit[] {
  const edits: Edit[] = []
  const additions: Record<string, PropValue> = {}
  for (const [name, value] of Object.entries(props)) {
    if (!propNamePattern.test(name)) throw new Error(`${name} is not a valid property name`)
    const existing = attribute(element, name)
    if (value === null) {
      if (!existing) throw new Error(`This element has no ${name} property to remove`)
      edits.push({ start: skipLeadingSpace(source, existing.getStart()), end: existing.getEnd(), text: "" })
      continue
    }
    if (existing) {
      edits.push({ start: existing.getStart(), end: existing.getEnd(), text: serializeProp(name, value) })
      continue
    }
    additions[name] = value
  }
  const additionText = serializeProps(additions)
  if (additionText) {
    const insertAt = element.attributes.getEnd()
    edits.push({ start: insertAt, end: insertAt, text: additionText })
  }
  return edits
}

function insertChild(source: string, board: ts.JsxElement | ts.JsxSelfClosingElement, text: string, kind: "component" | "trace"): Edit {
  if (!ts.isJsxElement(board)) throw new Error("This board has no children, so elements cannot be added to it")
  const existing = children(board)
  const isComponent = (child: ts.JsxElement | ts.JsxSelfClosingElement) => {
    const tag = tagName(child)
    return !!tag && !nonComponentElements.has(tag)
  }
  const anchors = kind === "trace"
    ? existing.filter((child) => tagName(child) === "trace")
    : existing.filter(isComponent)
  const fallbackAnchors = kind === "trace" ? existing.filter(isComponent) : []
  const anchor = anchors.at(-1) ?? fallbackAnchors.at(-1)
  if (anchor) {
    const indent = lineIndent(source, anchor.getStart())
    return { start: anchor.getEnd(), end: anchor.getEnd(), text: `\n${indent}${text}` }
  }
  const nextChild = existing[0]
  if (nextChild) {
    const indent = lineIndent(source, nextChild.getStart())
    const start = skipLeadingSpace(source, nextChild.getStart())
    return { start, end: start, text: `${text}\n${indent}` }
  }
  const afterOpening = board.openingElement.getEnd()
  const indent = lineIndent(source, board.openingElement.getStart()) + "  "
  return { start: afterOpening, end: afterOpening, text: `\n${indent}${text}` }
}

function removeLine(source: string, element: ts.Node): Edit {
  const start = lineStart(source, element.getStart())
  let end = element.getEnd()
  while (end < source.length && (source[end] === " " || source[end] === "\t")) end += 1
  if (source[end] === "\r") end += 1
  if (source[end] === "\n") end += 1
  return { start, end, text: "" }
}

function lineStart(source: string, position: number) {
  const previous = source.lastIndexOf("\n", position - 1)
  return previous === -1 ? 0 : previous + 1
}

function lineIndent(source: string, position: number) {
  const start = lineStart(source, position)
  const match = /^[ \t]*/.exec(source.slice(start, position))
  return match?.[0] ?? ""
}

function skipLeadingSpace(source: string, position: number) {
  let start = position
  while (start > 0 && (source[start - 1] === " " || source[start - 1] === "\t")) start -= 1
  return start === lineStart(source, position) ? position : start
}

function serializeProps(props: Record<string, PropValue>) {
  return Object.entries(props).map(([name, value]) => " " + serializeProp(name, value)).join("")
}

function serializeProp(name: string, value: PropValue) {
  if (!propNamePattern.test(name)) throw new Error(`${name} is not a valid property name`)
  if (typeof value === "boolean") return value ? name : `${name}={false}`
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${name} must be a finite number`)
    return `${name}={${value}}`
  }
  // tscircuit selectors legitimately contain ">", which is safe inside a quoted JSX attribute.
  if (/["\\{}<\n\r]/.test(value)) throw new Error(`${name} must not contain quotes, braces, opening angle brackets, or newlines`)
  return `${name}="${value}"`
}

function applyEdits(source: string, edits: Edit[]) {
  const ordered = [...edits].sort((a, b) => b.start - a.start || b.end - a.end)
  let output = source
  let lastStart = Number.POSITIVE_INFINITY
  for (const edit of ordered) {
    if (edit.end > lastStart) throw new Error("Conflicting source edits were produced")
    output = output.slice(0, edit.start) + edit.text + output.slice(edit.end)
    lastStart = edit.start
  }
  return output
}

function requireComponentName(name: string) {
  const trimmed = name.trim()
  if (!componentNamePattern.test(trimmed)) throw new Error("Component names may contain only letters, digits, hyphens, and underscores")
  return trimmed
}

function requireSelector(selector: string, field: string) {
  const trimmed = selector.trim()
  if (!trimmed) throw new Error(`A trace ${field} selector is required`)
  if (!/^[.#][A-Za-z0-9_\-. >]*$/.test(trimmed)) throw new Error(`${trimmed} is not a valid tscircuit selector`)
  return trimmed
}

function requireLength(value: string, field: string) {
  const trimmed = value.trim()
  if (!/^\d+(\.\d+)?(mm|cm|in|mil)$/.test(trimmed)) throw new Error(`Board ${field} must be a length with a unit, such as 30mm`)
  return trimmed
}

function requireLayers(layers: number) {
  if (!Number.isInteger(layers) || layers < 1 || layers > 32) throw new Error("Board layers must be a whole number between 1 and 32")
  return layers
}
