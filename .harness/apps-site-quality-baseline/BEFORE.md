# Axe Audit — BEFORE (baseline)

Generated: 2026-05-09T11:35:13.672Z
Base URL: http://127.0.0.1:5175

## Summary

| Route | Critical | Serious | Moderate | Minor | Total |
|-------|----------|---------|----------|-------|-------|
| Marketing (/) | 0 | 1 | 3 | 0 | 4 |
| Pricing (/pricing) | 0 | 0 | 3 | 0 | 3 |
| Trust (/trust) | 0 | 1 | 2 | 0 | 3 |
| Login (/login) | 0 | 2 | 0 | 0 | 2 |
| Dashboard (/dashboard) | 0 | 1 | 2 | 0 | 3 |

## Violation Detail

### Marketing (/)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 1 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |
| `heading-order` | moderate | 1 | Ensure the order of headings is semantically correct |
| `landmark-one-main` | moderate | 1 | Ensure the document has a main landmark |
| `region` | moderate | 12 | Ensure all page content is contained by landmarks |

### Pricing (/pricing)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `heading-order` | moderate | 1 | Ensure the order of headings is semantically correct |
| `landmark-one-main` | moderate | 1 | Ensure the document has a main landmark |
| `region` | moderate | 28 | Ensure all page content is contained by landmarks |

### Trust (/trust)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 3 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |
| `landmark-one-main` | moderate | 1 | Ensure the document has a main landmark |
| `region` | moderate | 11 | Ensure all page content is contained by landmarks |

### Login (/login)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 1 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |
| `nested-interactive` | serious | 1 | Ensure interactive controls are not nested as they are not always announced by s |

### Dashboard (/dashboard)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 19 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |
| `landmark-one-main` | moderate | 1 | Ensure the document has a main landmark |
| `region` | moderate | 8 | Ensure all page content is contained by landmarks |
