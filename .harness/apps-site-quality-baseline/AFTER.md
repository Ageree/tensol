# Axe Audit — AFTER (post-fix)

Generated: 2026-05-09T11:44:59.869Z
Base URL: http://127.0.0.1:5175

## Summary

| Route | Critical | Serious | Moderate | Minor | Total |
|-------|----------|---------|----------|-------|-------|
| Marketing (/) | 0 | 1 | 1 | 0 | 2 |
| Pricing (/pricing) | 0 | 0 | 1 | 0 | 1 |
| Trust (/trust) | 0 | 1 | 0 | 0 | 1 |
| Login (/login) | 0 | 2 | 0 | 0 | 2 |
| Dashboard (/dashboard) | 0 | 1 | 0 | 0 | 1 |

## Violation Detail

### Marketing (/)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 1 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |
| `heading-order` | moderate | 1 | Ensure the order of headings is semantically correct |

### Pricing (/pricing)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `heading-order` | moderate | 1 | Ensure the order of headings is semantically correct |

### Trust (/trust)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 3 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |

### Login (/login)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 1 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |
| `nested-interactive` | serious | 1 | Ensure interactive controls are not nested as they are not always announced by s |

### Dashboard (/dashboard)

| Rule ID | Impact | Nodes | Description |
|---------|--------|-------|-------------|
| `color-contrast` | serious | 19 | Ensure the contrast between foreground and background colors meets WCAG 2 AA min |
