import {
  ConcreteComponent,
  PropType,
  RendererElement,
  RendererNode,
  VNode,
  createTextVNode,
  defineComponent,
  h,
  ref,
  resolveComponent,
  watchEffect,
} from 'vue'
import {
  FormKitSchemaAttributes,
  FormKitSchemaNode,
  FormKitSchemaContext,
  isDOM,
  isConditional,
  isComponent,
  compile,
  FormKitSchemaCondition,
} from '@formkit/schema'
import { has, isPojo } from '@formkit/utils'

/**
 * A library of components available to the schema (in addition to globally
 * registered ones)
 */
interface FormKitComponentLibrary {
  [index: string]: ConcreteComponent
}

/**
 * Defines the structure a parsed node.
 */
type RenderContent = [
  condition: false | (() => boolean | number | string),
  element: string | ConcreteComponent | null,
  attrs: () => FormKitSchemaAttributes,
  children: RenderChildren | null,
  alternate: RenderChildren | null
]
/**
 * The actual signature of a VNode in Vue.
 */
type VirtualNode = VNode<RendererNode, RendererElement, { [key: string]: any }>
/**
 * The types of values that can be rendered by Vue.
 */
type Renderable = null | string | VirtualNode
/**
 * Describes renderable children.
 */
type RenderChildren = () =>
  | Renderable
  | Renderable[]
  | (Renderable | Renderable[])[]

/**
 * The format children elements can be in.
 */
type RenderNodes = () => Renderable | Renderable[]

/**
 * Extracts a reference object from a set of (reactive) data.
 * @param data - Returns a Vue ref object for the given path
 * @param token - A dot-notation path like: user.name
 * @returns
 * @internal
 */
function getRef(data: FormKitSchemaContext, token: string): { value: any } {
  const path = token.split('.')
  const value = ref(null)
  watchEffect(() =>
    path.reduce((obj: any, segment: string) => {
      if (has(obj, segment) && isPojo(obj[segment])) {
        return obj[segment]
      }
      value.value = obj[segment]
    }, data)
  )
  return value
}

/**
 * Given an $if/$then/$else schema node, pre-compile the node and return the
 * artifacts for the render function.
 * @param data - The schema context object
 * @param library - The available components
 * @param node - The node to parse
 */
function parseCondition(
  data: FormKitSchemaContext,
  library: FormKitComponentLibrary,
  node: FormKitSchemaCondition
): [RenderContent[0], RenderContent[3], RenderContent[4]] {
  const condition = compile(node.$if).provide((token) => {
    const value = getRef(data, token)
    return () => value.value
  })
  const children = parseSchema(data, library, node.$then)
  const alternate = node.$else ? parseSchema(data, library, node.$else) : null
  return [condition, children, alternate]
}

/**
 * Parse attributes for dynamic content.
 * @param attrs - Object of attributes
 * @returns
 */
function parseAttrs(
  data: FormKitSchemaContext,
  unparsedAttrs?: FormKitSchemaAttributes
): () => FormKitSchemaAttributes {
  if (unparsedAttrs) {
    const attrs: FormKitSchemaAttributes = {}
    const setters: Array<() => void> = []
    for (const attr in unparsedAttrs) {
      attrs[attr] = undefined
      const value = unparsedAttrs[attr]
      if (
        typeof value === 'string' &&
        value.startsWith('$') &&
        value.length > 1
      ) {
        // In this case we have a dynamic value, so we create a "setter" function
        // that will manipulate the value of our attribute at runtime.
        const dynamicValue = getRef(data, value.substr(1))
        setters.push(() => {
          Object.assign(attrs, { [attr]: dynamicValue.value })
        })
      } else if (typeof value === 'object' && isPojo(value)) {
        // In this case we need to recurse
        const subAttrs = parseAttrs(data, value)
        setters.push(() => {
          Object.assign(attrs, { [attr]: subAttrs() })
        })
      } else {
        // In all other cases, the value is static
        attrs[attr] = value
      }
    }
    return () => {
      setters.forEach((setter) => setter())
      // Unfortunately this spreading is necessary to trigger reactivity
      return { ...attrs }
    }
  }
  return () => null
}

/**
 * Given a single schema node, parse it and extract the value.
 * @param data - A state object provided to each node
 * @param node - The schema node being parsed
 * @returns
 */
function parseNode(
  data: FormKitSchemaContext,
  library: FormKitComponentLibrary,
  node: FormKitSchemaNode
): RenderContent {
  let element: RenderContent[1] = null
  let attrs: () => FormKitSchemaAttributes = () => null
  let condition: false | (() => boolean | number | string) = false
  let children: RenderContent[3] = null
  let alternate: RenderContent[4] = null
  if (typeof node === 'string') {
    throw new Error('Invalid schema')
  }

  if (isDOM(node)) {
    // This is an actual HTML DOM element
    element = node.$el
    attrs = parseAttrs(data, node.attrs)
  } else if (isComponent(node)) {
    // This is a Vue Component
    if (typeof node.$cmp === 'string') {
      element = has(library, node.$cmp)
        ? library[node.$cmp]
        : resolveComponent(node.$cmp)
    } else {
      // in this case it must be an actual component
      element = node.$cmp
    }
    attrs = parseAttrs(data, node.props)
  } else if (isConditional(node)) {
    // This is an $if/$then schema statement
    ;[condition, children, alternate] = parseCondition(data, library, node)
  }

  // This is the same as a "v-if" statement — not an $if/$else statement
  if (!isConditional(node) && '$if' in node) {
    condition = compile(node.$if as string).provide((token) => {
      const value = getRef(data, token)
      return () => value.value
    })
  }

  // Compile children down
  if ('children' in node && node.children) {
    const nodes =
      typeof node.children == 'string' ? [node.children] : node.children
    if (Array.isArray(nodes)) {
      // We are dealing with node sub-children
      const elements = nodes.map(createElement.bind(null, data, library))
      children = () => elements.map((e) => e())
    } else {
      // This is a conditional $if/$else clause
      const [childCondition, c, a] = parseCondition(data, library, nodes)
      children = () =>
        childCondition && childCondition() ? c && c() : a && a()
    }
  }

  return [condition, element, attrs, children, alternate]
}

/**
 * Creates an element
 * @param data - The context data available to the node
 * @param node - The schema node to render
 * @returns
 */
function createElement(
  data: FormKitSchemaContext,
  library: FormKitComponentLibrary,
  node: FormKitSchemaNode
): RenderNodes {
  if (typeof node === 'string') {
    const value =
      node.startsWith('$') && node.length > 1
        ? compile(node).provide((token: string) => {
            const value = getRef(data, token)
            return () => {
              return value.value
            }
          })
        : () => node
    return () => createTextVNode(String(value()))
  }
  const [condition, element, attrs, children, alternate] = parseNode(
    data,
    library,
    node
  )
  return (() => {
    if (condition && element === null && children) {
      // Handle conditional $if/$then statements
      return condition() ? children() : alternate && alternate()
    }

    if (element && (!condition || condition())) {
      // Handle standard elements and components
      return h(
        element,
        attrs(),
        typeof children === 'function' ? (children() as Renderable[]) : []
      )
    }
    return typeof alternate === 'function' ? alternate() : alternate
  }) as RenderNodes
}

/**
 * Given a schema, parse it and return the resulting renderable nodes.
 * @param data - The schema context object
 * @param library - The available components
 * @param node - The node to parse
 * @returns
 */
function parseSchema(
  data: FormKitSchemaContext,
  library: FormKitComponentLibrary,
  nodes: FormKitSchemaNode | FormKitSchemaNode[]
): RenderNodes | RenderChildren {
  if (Array.isArray(nodes)) {
    const els = nodes.map(createElement.bind(null, data, library))
    return () => els.map((e) => e())
  }
  // Single node to render
  const element = createElement(data, library, nodes)
  return () => element()
}

/**
 * The FormKitSchema vue component:
 */
export const FormKitSchema = defineComponent({
  props: {
    schema: {
      type: [Array, Object] as PropType<
        FormKitSchemaNode[] | FormKitSchemaCondition
      >,
      required: true,
    },
    data: {
      type: Object as PropType<FormKitSchemaContext>,
      default: () => ({}),
    },
    library: {
      type: Object as PropType<FormKitComponentLibrary>,
      default: () => ({}),
    },
  },
  setup(props) {
    let element: RenderNodes | RenderChildren
    watchEffect(() => {
      element = parseSchema(props.data, props.library, props.schema)
    })
    return () => element()
  },
})