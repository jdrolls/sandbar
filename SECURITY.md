# Security

Sandbar's whole reason to exist is letting an AI agent run wild on a computer that *isn't yours* — so the isolation boundary is the product. If you find a way across it, we want to know.

## Reporting a vulnerability

Please **do not open a public issue** for security problems. Use [GitHub private vulnerability reporting](https://github.com/jdrolls/sandbar/security/advisories/new) instead. You'll get a response within a few days.

In scope, especially:

- Container escape from a Sandbar computer to the host
- Reaching another user's computer, desktop stream, or terminal without their token
- Auth bypass on any desktop / terminal / API route
- Secret leakage (API keys, tokens) into images, logs, or streams

## Design commitments

- Non-root agent user inside computers; hardened runtime defaults
- No Docker socket mounted into anything internet-facing
- Every surface requires auth — no security-by-unguessable-URL
- Private-by-default networking (Tailscale first); public exposure is explicit
- Pinned agent versions — no `@latest` in shipped images
