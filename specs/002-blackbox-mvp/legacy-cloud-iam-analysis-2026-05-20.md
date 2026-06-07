# Deprecated Legacy Cloud IAM Analysis

This was a provider-specific IAM troubleshooting note from the pre-GCP/Sthrip
production posture. The detailed account identifiers, CLI commands, endpoint
names, and env var names were removed to avoid future operational confusion.

Current credential rotation and access checks should follow
`docs/runbooks/secret-rotation.md`, `server/.env.example`, and the GCP
Compute Engine configuration documented in `docs/project-current-context.md`.
