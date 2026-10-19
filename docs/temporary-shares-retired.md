# Temporary Shares — retired

Temporary Shares is no longer a product feature. Do not rebuild it, the Share
Viewer, or a desktop `.carshare` pipeline. This file is the canonical record of
that decision.

## What it was

Temporary Shares packaged selected project work into an encrypted `.carshare`
file and emitted an unsigned Share Viewer from the Report Generator so a
collaborator could unlock, edit, and optionally return that work without a
server. The operator tracked issued packages from an in-app dashboard; each
package carried a signed expiry, a device-bound activation, optional extension
passwords, and a work-return path authenticated by the package key.

## Why it is being removed now

The owner decided to remove it now, for three reasons:

1. **The feature has been super buggy.** Too much of it was fragile in practice
   — packaging, unlock, expiry, the Viewer emit path, Windows identity, and the
   surrounding harness — and that was not getting better fast enough.
2. **It requires far too much manual testing on a Windows computer the
   developer does not personally own.** The only Windows 11 box available
   belongs to a family member. Those checks had to be driven personally, from a
   released installer downloaded via its Azure link in a browser on that
   machine. That is not a sustainable way to keep a desktop sharing product
   honest.
3. **Sharing will be rebuilt later as a website.** Delivery, access, and expiry
   belong somewhere the operator actually controls, not in an unsigned Viewer
   plus an encrypted package shipped out of a desktop app.

Do not re-argue the old desktop-share decisions (one released app, issuer key
inside the operator install, nothing reports back, and so on). They described
a product that is being removed, not constraints on what comes next.

## What is gone

All of this is retired with the feature:

- The operator Temporary Shares dashboard
- The Share Viewer (embedded runtime, emit-on-create, and any separate build)
- `.carshare` packages and the `.carreturn` work-return path
- The issuer key, SecretStore provisioning, and `SHARE_ISSUER_PRIVATE_KEY`
- The Verify Windows Share gate and the quoted Windows share runs
- Spike 3 and the by-hand adversarial checklist
- Schema tables `temporary_share`, `temporary_share_extension`,
  `temporary_share_audit`, and `temporary_share_return`, plus
  `project.imported_from_license_id` / `imported_at` (schema v9 drops them)

The original design lived in git history under `docs/share-*.md`,
`docs/temporary-shares.md`, and `docs/share-plan-archive.md`. Those filenames
are withdrawn; do not treat any leftover copy as current.

## What stays

The desktop Report Generator is the product:

- Local project / building / asset editing and the property-report PDF
- AI photo captions and executive-summary writing (OpenRouter session key)
- Autosave and undo/redo
- Backup / restore and user-approved schema migrations
- Release Desktop, for this desktop app only

Removing Temporary Shares is not itself a release. `package.json` version is
not bumped, and no installer is published as part of this removal.

## Future sharing

Sharing and access control move to a website, where the operator has more
control over delivery, who can open the work, and when it expires. That work
is not started. There is no leftover desktop share design to finish first, and
this document does not specify the site.
