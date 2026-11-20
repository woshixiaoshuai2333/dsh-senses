// 工具 schema 编译器。
//
// DSH 自己的 defineTool 在 @deepseek-ai/dsh-tools 里，但 profile 的 node_modules
// 中并不保证能解析到那个包，所以这里复刻一份等价的最小实现：
//   - 把插件里写的「自定义参数 DSL」编译成标准 JSON Schema
//   - 编译输出 schema
//   - 给 execute 套一层参数校验
//
// 编译规则和 DSH 保持一致：
//   * object 必须显式写 additionalProperties（true 或 false），否则报错
//   * required: true 写在每个属性上，编译时汇总成 JSON Schema 的 required 数组
//   * type: 'json' 表示「任意 JSON」，编译成只有注解的节点
//   * enum 必须是数组

const SCALAR_TYPES = ['string', 'number', 'integer', 'boolean', 'null']

function compileValue(node) {
  if (node === null || typeof node !== 'object') {
    throw new Error('工具 schema 节点必须是对象')
  }

  const out = {}
  if (typeof node.description === 'string') out.description = node.description
  if (node.type === 'json') return out

  if (node.type === 'object') {
    out.type = 'object'
    out.additionalProperties = node.additionalProperties === true
    if (node.properties) {
      const properties = {}
      const required = []
      for (const [key, value] of Object.entries(node.properties)) {
        properties[key] = compileValue(value)
        if (value && value.required === true) required.push(key)
      }
      out.properties = properties
      if (required.length > 0) out.required = required
    }
    return out
  }

  if (node.type === 'array') {
    out.type = 'array'
    if (node.items) out.items = compileValue(node.items)
    return out
  }

  if (SCALAR_TYPES.includes(node.type)) {
    out.type = node.type
    if (Array.isArray(node.enum)) out.enum = node.enum
    if (typeof node.minimum === 'number') out.minimum = node.minimum
    if (typeof node.maximum === 'number') out.maximum = node.maximum
    return out
  }

  throw new Error(`不支持的 schema 类型: ${String(node.type)}`)
}

function compileParameters(spec) {
  const properties = {}
  const required = []
  for (const [key, value] of Object.entries(spec || {})) {
    properties[key] = compileValue(value)
    if (value && value.required === true) required.push(key)
  }
  return {
    type: 'object',
    properties,
    additionalProperties: true,
    ...(required.length > 0 ? { required } : {}),
  }
}

// ---------------------------------------------------------------------------
// 参数校验
// ---------------------------------------------------------------------------

function typeOf(value) {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function checkRange(path, schema, value) {
  if (typeof schema.minimum === 'number' && value < schema.minimum) {
    throw new Error(`参数 ${path} 不能小于 ${schema.minimum}，收到 ${value}`)
  }
  if (typeof schema.maximum === 'number' && value > schema.maximum) {
    throw new Error(`参数 ${path} 不能大于 ${schema.maximum}，收到 ${value}`)
  }
}

function checkValue(path, schema, value) {
  if (!schema || typeof schema !== 'object') return

  // type: 'json' 接受任何值
  if (!schema.type) return

  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`参数 ${path} 只能是 ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')}，收到 ${JSON.stringify(value)}`)
  }

  const actual = typeOf(value)
  switch (schema.type) {
    case 'string':
      if (actual !== 'string') throw new Error(`参数 ${path} 应该是字符串，收到 ${actual}`)
      return
    case 'number':
      if (actual !== 'number' || !Number.isFinite(value)) throw new Error(`参数 ${path} 应该是数字，收到 ${actual}`)
      checkRange(path, schema, value)
      return
    case 'integer':
      if (actual !== 'number' || !Number.isInteger(value)) throw new Error(`参数 ${path} 应该是整数，收到 ${actual}`)
      checkRange(path, schema, value)
      return
    case 'boolean':
      if (actual !== 'boolean') throw new Error(`参数 ${path} 应该是布尔值，收到 ${actual}`)
      return
    case 'null':
      if (actual !== 'null') throw new Error(`参数 ${path} 应该是 null，收到 ${actual}`)
      return
    case 'array':
      if (actual !== 'array') throw new Error(`参数 ${path} 应该是数组，收到 ${actual}`)
      if (schema.items) value.forEach((item, i) => checkValue(`${path}[${i}]`, schema.items, item))
      return
    case 'object': {
      if (actual !== 'object') throw new Error(`参数 ${path} 应该是对象，收到 ${actual}`)
      const props = schema.properties || {}
      for (const [key, sub] of Object.entries(props)) {
        if (value[key] === undefined) continue
        checkValue(`${path}.${key}`, sub, value[key])
      }
      return
    }
    default:
      return
  }
}

function validateArgs(parameters, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const required = parameters.required || []
  const missing = required.filter((key) => input[key] === undefined || input[key] === null)
  if (missing.length > 0) {
    throw new Error(`缺少必填参数：${missing.join('、')}`)
  }
  for (const [key, sub] of Object.entries(parameters.properties || {})) {
    if (input[key] === undefined) continue
    checkValue(key, sub, input[key])
  }
  return input
}

/**
 * 定义并返回一个工具。
 * options: { name, description, parameters, output: { schema, render }, execute, timeoutMs?, isConcurrencySafe? }
 */
export function defineTool(options) {
  const parameters = compileParameters(options.parameters)

  return {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: compileValue(options.output.schema),
      render: options.output.render,
    },
    ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.isConcurrencySafe !== undefined ? { isConcurrencySafe: options.isConcurrencySafe } : {}),
    async execute(args, exec) {
      const input = validateArgs(parameters, args)
      return options.execute(input, exec)
    },
  }
}

export const _internal = { compileValue, compileParameters, validateArgs }