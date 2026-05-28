---
severity: medium
title: Reflected XSS on /search?q=
---

The search endpoint reflects the `q` parameter unsanitized.

	Code sample with tab:
	`<script>alert(1)</script>`

Multi-line body
with several paragraphs.
