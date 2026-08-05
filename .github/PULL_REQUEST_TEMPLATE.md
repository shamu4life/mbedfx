## Summary

<!-- What changes, and why. If it fixes an issue, "Fixes #123". -->

-

## Type of change

- [ ] Bug fix — a card was wrong, missing, or a link wouldn't resolve `→ PATCH`
- [ ] New site or new path shape `→ MINOR`
- [ ] Feature or behaviour change `→ MINOR`
- [ ] Breaking change — a url shape or a rendered card changes for existing links `→ MAJOR`
- [ ] Docs / internal only `→ no version bump`

## Where did you measure it?

<!-- Only if this change rests on what an upstream returned. Datacenter egress and a laptop
     routinely get different bytes from the same url. A feature that works from a laptop and
     does nothing in production is this project's most common failure. -->

-

## Checklist

### Code
- [ ] `npm run build` passes (tests + typecheck)
- [ ] No new network calls in tests
- [ ] Assertions are on response **content**, not on status

### Behaviour changes
- [ ] Any test that pinned the old behaviour is rewritten, not deleted, and says what changed
  (or N/A)

### Version & changelog
- [ ] `docs/CHANGELOG.md` updated (or N/A, internal only)
- [ ] `package.json` version bumped (or N/A)

### Documentation
- [ ] README / site table updated for a new site (or N/A)
