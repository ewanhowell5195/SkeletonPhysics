import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
const CEM = path.join(here, "..", "assets", "minecraft", "optifine", "cem")
const TEMPLATES = path.join(here, "templates")
const type = JSON.parse(fs.readFileSync(path.join(here, "physics.json"), "utf8"))

const prefix = v => (v ? v + " + " : "")
const volume = b => b.coordinates[3] * b.coordinates[4] * b.coordinates[5]

const names = process.argv.length > 2 ? process.argv.slice(2)
  : fs.readdirSync(TEMPLATES).filter(f => f.endsWith(".jem")).map(f => f.slice(0, -4))

for (const name of names) {
  const model = JSON.parse(fs.readFileSync(path.join(TEMPLATES, name + ".jem"), "utf8"))
  const configFile = path.join(here, "configs", name + ".json")
  if (!fs.existsSync(configFile)) {
    write(name, model)
    console.log(name + ": copied")
    continue
  }

  const config = loadConfig(name)
  const rigged = config.rig === false ? model : rig(model, config)
  const parts = derive(rigged, config)
  const blocks = parts.length ? expand(parts, config) : []
  if (config.extra) blocks.push(Object.assign({}, config.extra))
  if (blocks.length) rigged.models.find(m => m.submodels).animations = blocks
  write(name, rigged)
  console.log(name + ": " + blocks.reduce((n, b) => n + Object.keys(b).length, 0) + " assignments in " + blocks.length + " blocks")
}

function rig(template, config) {
  const rootName = config.rootPart || "body"
  const pivotOf = p => p.translate.map(v => -v)
  const centreOf = b => [0, 1, 2].map(i => b.coordinates[i] + b.coordinates[i + 3] / 2)
  const rebase = (boxes, by) => boxes.map(b => Object.assign({}, b, {
    coordinates: [0, 1, 2].map(i => b.coordinates[i] - by[i]).concat(b.coordinates.slice(3))
  }))

  // parts sharing a cube centre are one piece, which is how a hat layer joins its head
  const wanted = config.order && new Set(config.order)
  const pieces = new Map()
  for (const part of template.models) {
    if (!part.boxes) continue
    // a part whose cubes are separate pieces names each of them in cube order
    const split = ((config.parts || {})[part.part] || {}).split
    const groups = split ? part.boxes.map((b, i) => ({ name: split[i], boxes: [b] })) : [{ name: part.part, boxes: part.boxes }]
    for (const g of groups) {
      if (!g.name) continue
      if (wanted && !wanted.has(g.name)) continue
      const key = split ? g.name : centreOf(g.boxes[0]).join(",")
      if (!pieces.has(key)) pieces.set(key, [])
      pieces.get(key).push(Object.assign({}, part, { boxes: g.boxes, piece: g.name }))
    }
  }

  // a part with no cubes of its own rides on another piece, carrying its submodels
  const riders = new Map()
  for (const part of template.models) {
    const on = ((config.parts || {})[part.part] || {}).rideOn
    if (!on || part.boxes || !part.submodels) continue
    if (!riders.has(on)) riders.set(on, [])
    riders.get(on).push(part)
  }

  const root = template.models.find(p => p.part === rootName)
  const anchorPart = config.anchor && template.models.find(p => p.part === config.anchor)
  const anchor = anchorPart ? pivotOf(anchorPart) : null

  const bones = []
  const poses = new Map()
  const grouped = new Map()
  const hostPivot = new Map()
  for (const members of pieces.values()) {
    const lead = members[0]
    const name = lead.piece || lead.part
    const spec = (config.parts || {})[name] || (config.parts || {})[lead.part] || {}
    const pivot = spec.pivot || ((config.parts || {})[lead.part] || {}).pivot || pivotOf(lead)
    const centre = centreOf(lead.boxes[0])

    const physics = { id: "physics_" + name, invertAxis: "xy" }
    if (lead.mirrorTexture) physics.mirrorTexture = lead.mirrorTexture
    const at = lead.part === rootName && !config.cancel ? centre : [0, 1, 2].map(i => centre[i] - pivot[i])
    if (at.some(v => v)) physics.translate = at
    physics.boxes = members.flatMap(m => rebase(m.boxes, centre))

    // a part's own submodels, the overlay layers, ride along on the piece
    const extra = members.flatMap(m => m.submodels || [])
    if (extra.length) physics.submodels = extra.map(s => Object.assign({}, s, {
      translate: [0, 1, 2].map(i => pivot[i] - centre[i]),
      boxes: rebase(s.boxes, pivot)
    }))

    for (const rider of riders.get(name) || []) {
      const lead2 = rider.submodels[0]
      const base = [0, 1, 2].map(i => lead2.translate[i] - centre[i])
      const wrap = { id: rider.part + "2", invertAxis: "xy", translate: base, submodels: rider.submodels.map((sub, i) => {
        const out = Object.assign({}, sub)
        if (i === 0) delete out.translate
        else out.translate = [0, 1, 2].map(j => sub.translate[j] - lead2.translate[j])
        return out
      }) }
      physics.submodels = (physics.submodels || []).concat([wrap])
    }

    if (lead.part === rootName) { bones.unshift(physics); continue }

    // pieces sharing a pose bone hang off the one named by their source
    // pieces group onto one pose bone by source, named after the first of them
    const group = ((config.parts || {})[name] || {}).source || name
    const poseName = (grouped.get(group) || name) + (config.poseSuffix || "2")
    if (!grouped.has(group)) grouped.set(group, name)
    const existing = poses.get(poseName)
    if (existing) { existing.submodels.push(physics); continue }

    const pose = { id: poseName, invertAxis: "xy" }
    if (lead.mirrorTexture) pose.mirrorTexture = lead.mirrorTexture
    pose.translate = anchor ? [0, 1, 2].map(i => pivot[i] - anchor[i]) : pivot
    pose.submodels = [physics]
    poses.set(poseName, pose)
    const host = spec.under && poses.get(spec.under + (config.poseSuffix || "2"))
    if (host) {
      pose.translate = [0, 1, 2].map(i => pivot[i] - hostPivot.get(spec.under)[i])
      host.submodels.push(pose)
    } else bones.push(pose)
    hostPivot.set(name, pivot)
  }

  const pivot = pivotOf(root)
  let inner = bones
  let rotate = { id: "rotate", invertAxis: "xy" }
  let top = rotate

  if (config.cancel) {
    // the flip cancel has to sit inside the counter-rotation, and the yaw it also
    // carries needs its axis on the entity centre, which z alone can be moved onto
    const physics = bones.shift()
    const held = { id: "body_cancel", invertAxis: "xy", translate: pivot, submodels: bones }
    inner = [{ id: "body2", invertAxis: "xy", translate: pivot, submodels: [physics] }, held]
    const yaw = config.yawOffset || 0
    rotate.translate = [root.translate[0], root.translate[1], root.translate[2] + yaw]
    top = { id: "cancel", invertAxis: "xy", translate: pivot, submodels: [rotate] }
  }

  // the translate group holds the rig at the height the mob died at
  const shift = config.cancel && config.yawOffset ? { translate: [0, 0, -config.yawOffset] } : {}
  rotate.submodels = [Object.assign({ id: "translate", invertAxis: "xy" }, shift, { submodels: inner })]

  const out = { credit: template.credit }
  if (template.textureSize) out.textureSize = template.textureSize
  out.models = [{
    part: rootName, id: rootName, invertAxis: "xy", translate: root.translate, submodels: [top]
  }].concat(template.models.filter(p => p.part !== rootName).map(p => ({ part: p.part })))
  return out
}

function write(name, model) {
  const targeted = new Set()
  for (const m of model.models) for (const b of m.animations || []) for (const k in b) targeted.add(k.split(".")[0])

  const drawn = node => JSON.stringify(node).includes("\"boxes\"")
  function clean(node) {
    const out = {}
    for (const key in node) {
      if (!drawn(node) && !["part", "submodels", "animations"].includes(key) && !(key === "id" && targeted.has(node.id))) continue
      out[key] = key === "submodels" ? node[key].map(clean) : node[key]
    }
    return out
  }

  const stripped = { credit: model.credit }
  if (drawn(model)) stripped.textureSize = model.textureSize
  stripped.models = model.models.map(clean)
  fs.writeFileSync(path.join(CEM, name + ".jem"), JSON.stringify(stripped))
}

function loadConfig(name) {
  const config = JSON.parse(fs.readFileSync(path.join(here, "configs", name + ".json"), "utf8"))
  if (!config.extends) return config
  const base = loadConfig(config.extends)
  delete config.extends
  return Object.assign({}, base, config, { parts: Object.assign({}, base.parts, config.parts) })
}

function derive(geometry, config) {
  const root = geometry.models.find(m => m.part === (config.rootPart || "body"))
  const origin = config.origin === undefined ? 24 : config.origin
  const collide = config.collide !== false
  const vanilla = new Set(geometry.models.map(m => m.part).filter(Boolean))
  const parts = []

  // heights are Blockbench style, feet at 0, so declared translate y adds directly
  ;(function walk(node, y, parent) {
    const at = y + (node.translate ? node.translate[1] : 0)
    if (node.id && node.id.startsWith("physics_")) {
      const name = node.id.slice("physics_".length)
      const spec = (config.parts || {})[name] || {}

      const named = parent && parent.endsWith("2") ? parent.slice(0, -1).replace(/_$/, "") : null
      const source = spec.source || named
      const pose = named && vanilla.has(source) ? parent : null

      const declared = spec.copy || ["rx", "ry", "rz"]
      const custom = Array.isArray(declared) ? {} : declared

      // sizeAdd boxes are overlay layers, so the radius follows the solid cube
      const solid = node.boxes.filter(b => !b.sizeAdd)
      const box = (solid.length ? solid : node.boxes).reduce((a, b) => (volume(b) > volume(a) ? b : a))
      const radius = spec.radius === undefined ? Math.min(...box.coordinates.slice(3)) / 2 : spec.radius

      const t = node.translate || [0, 0, 0]
      parts.push({
        part: name,
        bone: pose,
        source,
        posed: !!pose,
        track: !!spec.track,
        copy: pose ? (Array.isArray(declared) ? declared : Object.keys(custom)) : [],
        custom,
        coef: t[1],
        offsetx: prefix(-t[0]),
        offsety: prefix(-t[1]),
        offsetz: prefix(t[2]),
        floor: collide ? "var.floor_" + name + " * " : "",
        bounce: collide ? "if(var.floor_" + name + " == 1, 1, -var.floor_" + name + ") * " : "",
        base: origin - radius,
        rest: at - radius
      })
    }
    for (const s of node.submodels || []) walk(s, at, node.id)
  })({ submodels: root.submodels }, 0, null)

  const order = config.order || parts.map(p => p.part)
  return parts.sort((a, b) => order.indexOf(a.part) - order.indexOf(b.part))
}

function expand(parts, config) {
  const globals = Object.assign({
    gravity: 1, shadow: 0.5, scale: 1, kick: [2, 4], lift: [1, 2], spin: [0.5, 1], spinY: [0.5, 1]
  }, config)
  globals.pixels = 16 / globals.scale
  // pairs read as [in water, out of water]
  for (const k of ["kick", "lift", "spin", "spinY"]) {
    globals[k + "_water"] = globals[k][0]
    globals[k + "_air"] = globals[k][1]
  }

  const latched = new Map()
  const latch = (source, axis) => latched.set(source + "_" + axis, { source, axis, name: source + "_" + axis })
  for (const p of parts) {
    if (p.posed) latch(p.source, "ty")
    if (p.track) latch(p.source, "tz")
    for (const axis of p.copy) latch(p.source, axis)
  }
  if (config.anchor) for (const axis of ["ty", "tz"]) latch(config.anchor, axis)

  const rows = {
    once: [{}],
    part: parts,
    latch: Array.from(latched.values()).sort((a, b) => a.name.localeCompare(b.name)),
    axis: parts.flatMap(p => p.copy.map(axis => {
      const scope = Object.assign({ axis }, p)
      return Object.assign(scope, { expr: fill(p.custom[axis] || "var.{source}_{axis}", scope) })
    }))
  }

  function fill(text, scope) {
    return String(text).replace(/\{(\w+)\}/g, (whole, key) => {
      const value = scope[key] === undefined ? globals[key] : scope[key]
      if (value === undefined) throw new Error("no value for " + whole)
      return value
    })
  }

  function build(spec, scope) {
    const templates = Object.assign({}, spec.assign, scope.posed ? spec.posed : spec.plane)
    const keys = spec.order ? spec.order.filter(k => templates[k] !== undefined) : Object.keys(templates)
    const out = {}
    for (const key of keys) {
      const name = fill(key, scope)
      if (config.defines === false && !spec.always && name.startsWith("var.")) continue
      const template = templates[key]
      if (typeof template !== "string") { out[name] = template; continue }
      const bare = /^\{(\w+)\}$/.exec(template)
      out[name] = bare ? scope[bare[1]] ?? globals[bare[1]] : fill(template, scope)
    }
    return out
  }

  const blocks = []
  for (const section of type.sections) {
    if (section.needs === "collide" && config.collide === false) continue
    if (section.needs === "cancel" && !config.cancel) continue
    const scopes = (rows[section.per] || rows.once).filter(s => !section.when || (section.when === "plane" ? !s.posed : s[section.when]))
    if (section.blocks) {
      for (const scope of scopes) for (const spec of section.blocks) blocks.push(build(spec, scope))
      continue
    }
    const block = section.append && blocks.length ? blocks[blocks.length - 1] : {}
    for (const scope of scopes) Object.assign(block, build(section, scope))
    if (block !== blocks[blocks.length - 1]) blocks.push(block)
  }
  return blocks.filter(b => Object.keys(b).length)
}
