const { createHash, randomUUID } = require('node:crypto')

/**
 * Main-owned, sender-scoped save selections. The renderer receives only an
 * opaque one-shot id, so no filesystem path can be supplied back to the
 * privileged export handler. Main may return the completed destination after
 * writing so the UI can tell the user where the report was saved.
 */
function createReportExportCapabilities({ createId = randomUUID } = {}) {
  const pendingByOwner = new WeakMap()

  return {
    issue(owner, filePath) {
      if (!owner || typeof owner !== 'object' || !filePath) return null
      const exportId = String(createId())
      pendingByOwner.set(owner, { exportId, filePath: String(filePath) })
      return exportId
    },

    revoke(owner) {
      if (owner && typeof owner === 'object') pendingByOwner.delete(owner)
    },

    consume(owner, exportId) {
      if (!owner || typeof owner !== 'object') return null
      const pending = pendingByOwner.get(owner)
      if (!pending || pending.exportId !== String(exportId ?? '')) return null
      pendingByOwner.delete(owner)
      return pending.filePath
    },
  }
}

/**
 * One immutable, sender-scoped Word artifact per report window.
 *
 * Preparing a report is asynchronous. `begin` immediately invalidates the
 * previous artifact and returns an ownership token; `commit` accepts the build
 * only if no newer preparation has started in the meantime. Saving resolves a
 * reusable artifact, while the destination capability above remains one-shot.
 */
function createPreparedReportArtifacts({ createId = randomUUID } = {}) {
  const slotsByOwner = new WeakMap()

  function removeLifecycleListeners(slot) {
    for (const { target, event, listener } of slot?.lifecycleListeners ?? []) {
      target?.removeListener?.(event, listener)
    }
  }

  function revoke(owner) {
    if (!owner || typeof owner !== 'object') return false
    const slot = slotsByOwner.get(owner)
    if (!slot) return false
    removeLifecycleListeners(slot)
    slotsByOwner.delete(owner)
    return true
  }

  function begin(owner) {
    if (!owner || typeof owner !== 'object') return null
    revoke(owner)

    const previewId = String(createId())
    const slot = { previewId, artifact: null, lifecycleListeners: [] }
    const release = () => revoke(owner)
    const targets = [
      // `did-start-navigation` also fires for in-document Word bookmarks. A
      // TOC click must not invalidate the artifact it merely scrolled within.
      { target: owner.webContents, event: 'did-navigate' },
      { target: owner.webContents, event: 'destroyed' },
      { target: owner, event: 'closed' },
    ]
    for (const { target, event } of targets) {
      if (typeof target?.once !== 'function') continue
      target.once(event, release)
      slot.lifecycleListeners.push({ target, event, listener: release })
    }
    slotsByOwner.set(owner, slot)
    return previewId
  }

  function commit(owner, previewId, artifact) {
    if (!owner || typeof owner !== 'object') return false
    const slot = slotsByOwner.get(owner)
    if (!slot || slot.previewId !== String(previewId ?? '')) return false
    if (!Buffer.isBuffer(artifact?.buffer)) return false

    slot.artifact = {
      ...artifact,
      // The builder owns its return value. Copy it at this boundary so the
      // exact bytes reviewed by the renderer cannot later be mutated in place.
      buffer: Buffer.from(artifact.buffer),
    }
    return true
  }

  function resolve(owner, previewId) {
    if (!owner || typeof owner !== 'object') return null
    const slot = slotsByOwner.get(owner)
    if (
      !slot ||
      slot.previewId !== String(previewId ?? '') ||
      !slot.artifact
    ) {
      return null
    }
    return slot.artifact
  }

  return { begin, commit, resolve, revoke }
}

/** Stable for snapshots returned by the same database query shape. */
function fingerprintReportSnapshot(reports) {
  return createHash('sha256').update(JSON.stringify(reports ?? [])).digest('hex')
}

function positiveId(value) {
  const id = Number(value)
  return Number.isFinite(id) && id > 0 ? id : null
}

/**
 * Return the first active caption/summary job that can change any included
 * report. Building ids are authoritative; image/asset ids are fallbacks for a
 * malformed or older caption job that omitted its building id.
 */
function findRelevantReportAiJob(status, reports) {
  const buildingIds = new Set()
  const buildingImageIds = new Set()
  const assetIds = new Set()
  const assetImageIds = new Set()

  for (const report of reports ?? []) {
    const buildingId = positiveId(report?.building?.id)
    if (buildingId != null) buildingIds.add(buildingId)
    for (const image of report?.buildingImages ?? []) {
      const imageId = positiveId(image?.id)
      if (imageId != null) buildingImageIds.add(imageId)
    }
    for (const asset of report?.assets ?? []) {
      const assetId = positiveId(asset?.id)
      if (assetId != null) assetIds.add(assetId)
      for (const image of asset?.images ?? []) {
        const imageId = positiveId(image?.id)
        if (imageId != null) assetImageIds.add(imageId)
      }
    }
  }

  for (const job of status?.summaryJobs ?? []) {
    if (buildingIds.has(positiveId(job?.buildingId))) return job
  }
  for (const job of status?.captionJobs ?? []) {
    if (buildingIds.has(positiveId(job?.buildingId))) return job
    if (job?.kind === 'building' && buildingImageIds.has(positiveId(job?.imageId))) {
      return job
    }
    if (job?.kind !== 'building') {
      if (assetIds.has(positiveId(job?.assetId))) return job
      if (assetImageIds.has(positiveId(job?.imageId))) return job
    }
  }
  return null
}

module.exports = {
  createPreparedReportArtifacts,
  createReportExportCapabilities,
  findRelevantReportAiJob,
  fingerprintReportSnapshot,
}
