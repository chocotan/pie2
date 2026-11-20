import { readdir, readFile, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = fileURLToPath(new URL('../', import.meta.url))
const source = join(root, 'src')
const output = join(root, 'dist')
const sources = await readdir(source, { recursive: true, withFileTypes: true })
await rm(output, { recursive: true, force: true })
for (const entry of sources) {
  if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.d.ts')) continue
  const path = join(entry.parentPath, entry.name)
  const result = ts.transpileModule(await readFile(path, 'utf8'), {
    fileName: path,
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.ESNext,
      verbatimModuleSyntax: true,
      rewriteRelativeImportExtensions: true,
    },
  })
  const errors = result.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error) ?? []
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: name => name,
    getCurrentDirectory: () => root,
    getNewLine: () => '\n',
  }))
  const target = join(output, relative(source, path).replace(/\.ts$/, '.js'))
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, result.outputText)
}
