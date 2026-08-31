import { Ajv2020 } from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import fp from 'fastify-plugin'
import { specSchema } from '../openapi.ts'

const build = (coerceTypes: boolean | 'array') => {
  const ajv = new Ajv2020({
    allErrors: true,
    coerceTypes,
    useDefaults: coerceTypes !== false,
    strict: 'log',
    strictSchema: false
  })

  addFormats.default(ajv)
  ajv.addSchema(specSchema)

  return ajv
}

export default fp(async (app) => {
  const strict = build(false)
  const lenient = build('array')

  app.addSchema(specSchema)
  app.setValidatorCompiler(({ schema, httpPart }) =>
    httpPart === 'body' ? strict.compile(schema) : lenient.compile(schema)
  )
})
