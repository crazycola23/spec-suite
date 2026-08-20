#!/usr/bin/env node

/**
 * Deterministic, knowledge-only context projection for the V2 control-plane slice.
 *
 * Context(T) = Kernel union Closure(Roots(T)) union Blockers(Surface(T))
 *
 * Candidate roots can only add context. If the graph is incomplete, changed without
 * a matching canonical digest, or cannot classify a task surface, projection widens
 * to every graph node and becomes ineligible for lease issuance.
 */

import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  assertSchemaVersion,
  computeCanonicalRevision,
  contentDigest,
  jsonDigest,
  readJson,
  resolveInside,
  stableJson,
  stringSet,
  toPosix,
  writeJsonAtomic,
} from './control-plane-common.mjs'

const NODE_KINDS = new Set(['kernel', 'file', 'fact', 'gap', 'contract', 'action', 'provider', 'permission'])

function addReason(reasons, reason) {
  if (!reasons.includes(reason)) reasons.push(reason)
}

function parseArgs(argv) {
  const result = { roots: [], candidateRoots: [], surfaces: [] }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    switch (argument) {
      case '--specs-root': result.specsRoot = argv[++index]; break
      case '--graph': result.graph = argv[++index]; break
      case '--task': result.task = argv[++index]; break
      case '--state': result.state = argv[++index]; break
      case '--policy': result.policy = argv[++index]; break
      case '--output': result.output = argv[++index]; break
      case '--root': result.roots.push(argv[++index]); break
      case '--candidate-root': result.candidateRoots.push(argv[++index]); break
      case '--surface': result.surfaces.push(argv[++index]); break
      case '--help': result.help = true; break
      default: throw new Error(`unknown argument: ${argument}`)
    }
  }
  return result
}

const HELP = `Usage: node scripts/project-context.mjs [options]

  --specs-root <path>       repository/spec root (default: current directory)
  --graph <relative path>   dependency graph JSON
  --task <relative path>    task JSON
  --state <relative path>   canonical state JSON
  --policy <relative path>  issuer policy JSON (epoch only; never grants rights)
  --output <relative path>  write atomically instead of stdout
  --root <typed ID>         add an explicit root (repeatable)
  --candidate-root <ID>     add a heuristic/LLM candidate root (repeatable, additive only)
  --surface <ID>            add a task effect surface (repeatable)
`

function loadInputs(options) {
  const specsRoot = path.resolve(options.specsRoot ?? '.')
  const required = ['graph', 'task', 'state', 'policy']
  for (const key of required) {
    if (!options[key]) throw new Error(`missing --${key}`)
  }
  const paths = Object.fromEntries(required.map((key) => [
    key,
    resolveInside(specsRoot, options[key], `--${key}`),
  ]))
  return {
    specsRoot,
    paths,
    graph: readJson(paths.graph, 'context graph'),
    task: readJson(paths.task, 'task'),
    state: readJson(paths.state, 'canonical state'),
    policy: readJson(paths.policy, 'issuer policy'),
  }
}

function validateBase({ graph, task, state, policy }, reasons) {
  assertSchemaVersion(graph, 'context graph')
  assertSchemaVersion(task, 'task')
  assertSchemaVersion(state, 'canonical state')
  assertSchemaVersion(policy, 'issuer policy')
  if (typeof task.taskId !== 'string' || task.taskId.trim() === '') throw new Error('task.taskId must be non-empty')
  if (typeof state.canonicalRevision !== 'string' || state.canonicalRevision.trim() === '') {
    throw new Error('canonical state revision is unavailable')
  }
  if (!Number.isSafeInteger(policy.policyEpoch) || policy.policyEpoch < 1) {
    throw new Error('policy epoch is unavailable')
  }
  if (graph.complete !== true) addReason(reasons, 'dependency_graph_declared_incomplete')
}

function indexGraph(graph, reasons) {
  if (!Array.isArray(graph.nodes) || graph.nodes.length === 0) throw new Error('context graph must contain nodes')
  const nodes = new Map()
  for (const node of graph.nodes) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) {
      addReason(reasons, 'dependency_graph_has_invalid_node')
      continue
    }
    if (typeof node.id !== 'string' || node.id.trim() === '') {
      addReason(reasons, 'dependency_graph_has_invalid_node_id')
      continue
    }
    if (nodes.has(node.id)) addReason(reasons, `duplicate_node:${node.id}`)
    if (!NODE_KINDS.has(node.kind)) addReason(reasons, `unsupported_node_kind:${node.id}`)
    if (!Array.isArray(node.dependsOn)) addReason(reasons, `dependencies_unreadable:${node.id}`)
    nodes.set(node.id, node)
  }
  for (const node of nodes.values()) {
    for (const dependency of Array.isArray(node.dependsOn) ? node.dependsOn : []) {
      if (!nodes.has(dependency)) addReason(reasons, `missing_dependency_node:${node.id}->${dependency}`)
    }
  }
  return nodes
}

function rootsAndSurfaces(task, options) {
  return {
    explicitRoots: stringSet([...(task.roots ?? []), ...(options.roots ?? [])], 'task roots', { allowEmpty: false }),
    candidateRoots: stringSet([...(task.candidateRoots ?? []), ...(options.candidateRoots ?? [])], 'candidate roots'),
    surfaces: stringSet([...(task.surfaces ?? []), ...(options.surfaces ?? [])], 'task surfaces', { allowEmpty: false }),
  }
}

function collectBlockers(graph, surfaces, nodes, reasons) {
  if (!Array.isArray(graph.blockers)) {
    addReason(reasons, 'surface_blocker_index_unreadable')
    return []
  }
  const blockers = []
  for (const surface of surfaces) {
    const matches = graph.blockers.filter((entry) => entry?.surface === surface)
    if (matches.length !== 1 || !Array.isArray(matches[0]?.include)) {
      addReason(reasons, `surface_unclassified:${surface}`)
      continue
    }
    for (const id of matches[0].include) {
      if (!nodes.has(id)) addReason(reasons, `missing_blocker_node:${surface}->${id}`)
      else blockers.push(id)
    }
  }
  return [...new Set(blockers)].sort()
}

function closure(seed, nodes, reasons) {
  const selected = new Set()
  const pending = [...seed].sort().reverse()
  while (pending.length > 0) {
    const id = pending.pop()
    if (selected.has(id)) continue
    const node = nodes.get(id)
    if (!node) {
      addReason(reasons, `unknown_root_or_dependency:${id}`)
      continue
    }
    selected.add(id)
    for (const dependency of [...(Array.isArray(node.dependsOn) ? node.dependsOn : [])].sort().reverse()) {
      if (!selected.has(dependency)) pending.push(dependency)
    }
  }
  return selected
}

function loadDocuments(specsRoot, selectedIds, nodes, reasons) {
  const byPath = new Map()
  for (const id of [...selectedIds].sort()) {
    const node = nodes.get(id)
    if (typeof node?.path !== 'string' || node.path.trim() === '') continue
    let absolute
    try {
      absolute = resolveInside(specsRoot, node.path, `node path for ${id}`)
      const content = fs.readFileSync(absolute, 'utf8')
      const relative = toPosix(path.relative(specsRoot, absolute))
      const previous = byPath.get(relative)
      if (previous && previous.content !== content) addReason(reasons, `document_collision:${relative}`)
      byPath.set(relative, { path: relative, sha256: contentDigest(content), content })
    } catch {
      addReason(reasons, `document_unavailable:${id}`)
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path))
}

export function projectContext(options = {}) {
  const loaded = loadInputs(options)
  const { specsRoot, graph, task, state, policy } = loaded
  const reasons = []
  validateBase(loaded, reasons)
  const nodes = indexGraph(graph, reasons)
  const graphDigest = jsonDigest(graph)
  if (state.contextGraphDigest !== graphDigest) addReason(reasons, 'context_graph_revision_mismatch')
  try {
    if (state.canonicalRevision !== computeCanonicalRevision(specsRoot, state.canonicalInputs)) {
      addReason(reasons, 'canonical_revision_mismatch')
    }
  } catch {
    addReason(reasons, 'canonical_revision_unreadable')
  }

  const kernel = stringSet(graph.kernel ?? [], 'context graph kernel', { allowEmpty: false })
  const { explicitRoots, candidateRoots, surfaces } = rootsAndSurfaces(task, options)
  for (const id of [...kernel, ...explicitRoots, ...candidateRoots]) {
    if (!nodes.has(id)) addReason(reasons, `unknown_root:${id}`)
  }
  const blockers = collectBlockers(graph, surfaces, nodes, reasons)

  const activeConstraints = stringSet(state.activeConstraints ?? [], 'canonical active constraints')
  for (const constraint of activeConstraints) {
    if (!nodes.has(constraint)) addReason(reasons, `active_constraint_missing_from_graph:${constraint}`)
  }
  for (const blocker of blockers) {
    if (!activeConstraints.includes(blocker)) addReason(reasons, `blocker_not_active:${blocker}`)
  }

  let selected = closure([...kernel, ...explicitRoots, ...candidateRoots, ...blockers], nodes, reasons)
  if (reasons.length > 0) selected = new Set(nodes.keys())
  let documents = loadDocuments(specsRoot, selected, nodes, reasons)
  if (reasons.length > 0 && selected.size !== nodes.size) {
    selected = new Set(nodes.keys())
    documents = loadDocuments(specsRoot, selected, nodes, reasons)
  }

  const nodeProjection = [...selected].sort().map((id) => {
    const node = nodes.get(id)
    return {
      id,
      kind: node.kind,
      path: typeof node.path === 'string' ? toPosix(node.path) : null,
      dependsOn: stringSet(Array.isArray(node.dependsOn) ? node.dependsOn : [], `dependencies for ${id}`),
    }
  })
  const uncertaintyReasons = [...new Set(reasons)].sort()
  const projection = {
    schemaVersion: 1,
    type: 'context-projection',
    formula: 'Kernel U Closure(Roots(T)) U Blockers(Surface(T))',
    knowledgeOnly: true,
    grantsPrivilege: false,
    taskId: task.taskId,
    canonicalRevision: state.canonicalRevision,
    policyEpoch: policy.policyEpoch,
    contextGraphDigest: graphDigest,
    explicitRoots,
    candidateRoots,
    surfaces,
    blockers,
    activeConstraints,
    nodes: nodeProjection,
    documents,
    uncertainty: {
      increased: uncertaintyReasons.length > 0,
      reasons: uncertaintyReasons,
    },
    leaseEligible: uncertaintyReasons.length === 0,
    privilegeCeiling: uncertaintyReasons.length === 0 ? 'issuer-policy-only' : 'none',
  }
  projection.projectionDigest = jsonDigest(projection)
  return projection
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.help) {
      process.stdout.write(HELP)
      return 0
    }
    const projection = projectContext(options)
    if (options.output) {
      const root = path.resolve(options.specsRoot ?? '.')
      writeJsonAtomic(resolveInside(root, options.output, '--output'), projection)
    } else {
      process.stdout.write(`${stableJson(projection, 2)}\n`)
    }
    return projection.leaseEligible ? 0 : 2
  } catch (error) {
    process.stderr.write(`context projection failed closed: ${error.message}\n`)
    return 1
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === invokedPath) main().then((code) => process.exit(code))
