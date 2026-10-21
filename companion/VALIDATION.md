# Validation status — scanner 0.1.0

36 native/local tests passed on Linux using the source workspace environment. They cover detailed feature matching, rotation, blank/wrong images, cache roundtrips, natural-order stable-file intake, persistent drafts, manual labels, duplicate handling, retry after a lost response, and loopback authentication/CSRF/Host checks. These are functional tests, not an Epson exact-printing accuracy benchmark.

macOS installer execution, Finder launch, Keychain access and real Epson folder capture have not been tested on a Mac. The package is a source installer rather than a signed/notarized binary. Native-only automatic approval is not enabled; cloud re-verification remains the final automatic approval authority.

Cloud regression, isolated SQL and browser validation results are recorded in the release handoff. No production stock or keys are created by automated tests. Do not interpret server deployment readiness as macOS acceptance or a measured speedup.
