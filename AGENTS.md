# Agent Development Guide

> **This is the entry point for AI developer agents working on this codebase.**

## Quick Reference

| Document | Purpose | When to Read |
|----------|---------|--------------|
| [AGENTS.md](AGENTS.md) | Agent guidelines & rules | Always read first |
| [README.md](README.md) | Project overview & setup | Before making changes |
| [PRD.md](PRD.md) | Product requirements | When adding features |
| [DESIGN.md](DESIGN.md) | Technical architecture | When modifying rendering |
| [TESTING.md](TESTING.md) | Test guide | Before/after code changes |
| [CHANGES.md](CHANGES.md) | Recent changes log | To understand recent work |
| [SECURITY.md](SECURITY.md) | Security reporting | For security issues |

## Core Principles

### 1. No Dangling Files

Every file in this repository must be **referenced** from at least one other file:

- **Documentation files** → referenced from AGENTS.md or README.md
- **Code files** → imported by another file or test
- **Config files** → referenced in package.json or other configs
- **Assets** → imported or referenced in code

**Before adding a file:** Ensure it will be properly linked.
**Before removing a file:** Verify no references will break.

### 2. Documentation Maintenance Burden

Keep documentation **minimal and high-value**:

- **Don't duplicate information** → link to the source instead
- **Prefer code comments over external docs** for implementation details
- **Delete outdated docs** rather than let them mislead future agents
- **Use the Quick Reference table** above to describe each doc's purpose

**Test for staleness:** If updating code, grep for mentions in docs. Update or remove stale references.

### 3. Single Source of Truth

Each concept should have **one authoritative location**:

| Concept | Authoritative Location |
|---------|----------------------|
| How to build/test | `package.json` scripts |
| Architecture decisions | [DESIGN.md](DESIGN.md) |
| Product behavior | [PRD.md](PRD.md) |
| Test patterns | [TESTING.md](TESTING.md) |
| Agent rules | [AGENTS.md](AGENTS.md) (this file) |

## Development Commands

```bash
# Install dependencies
npm install

# Development server
npm run dev

# Lint code (fix errors before committing)
npm run lint

# Run all tests
npx vitest run

# Run tests in watch mode
npx vitest --watch

# Build for production
npm run build
```

## Code Style

- **TypeScript strict mode** is enabled
- **ESLint** enforces code quality - run `npm run lint` before committing
- Fix lint **errors** (required), **warnings** are advisory
- Use existing patterns - check similar files for conventions

## File Structure

```
├── AGENTS.md           # ← You are here (agent entry point)
├── README.md           # Project overview for humans
├── PRD.md              # Product requirements document
├── DESIGN.md           # Layer-based rendering architecture
├── TESTING.md          # Testing guide and patterns
├── CHANGES.md          # Recent changes log
├── SECURITY.md         # Security policy
├── src/
│   ├── App.tsx         # Main application component
│   ├── App.test.tsx    # Application tests
│   ├── lib/            # Core logic (renderer, utils)
│   ├── components/     # React components
│   ├── hooks/          # Custom React hooks
│   └── styles/         # CSS styles
├── package.json        # Dependencies and scripts
├── eslint.config.js    # ESLint configuration
├── tsconfig.json       # TypeScript configuration
└── vite.config.ts      # Vite build configuration
```

## Making Changes

### Before Changing Code

1. **Understand the context** → Read [DESIGN.md](DESIGN.md) for architecture
2. **Run tests first** → `npx vitest run` to see baseline state
3. **Check lint** → `npm run lint` to see existing issues

### After Changing Code

1. **Run tests** → `npx vitest run` to verify no regressions
2. **Run lint** → `npm run lint` and fix errors
3. **Update docs if needed** → Keep docs in sync with code

### Documentation Changes

When modifying documentation:

1. **Update the Quick Reference table** above if adding/removing docs
2. **Check for broken links** in all markdown files
3. **Consider if the doc is needed** → delete if obsolete

## Agent-Specific Rules

### When Adding New Files

- [ ] Is the file referenced/imported by existing code?
- [ ] If documentation, is it linked from AGENTS.md or README.md?
- [ ] Does it follow existing naming conventions?

### When Removing Files

- [ ] Are all references to this file removed?
- [ ] Is the Quick Reference table updated?
- [ ] Are tests still passing?

### When Modifying Architecture

- [ ] Is [DESIGN.md](DESIGN.md) updated to reflect changes?
- [ ] Are affected tests updated?

## Governance

This AGENTS.md file is the **authoritative source** for agent development guidelines. It should be:

- **Read first** by any agent before making changes
- **Updated** when development practices change
- **Referenced** from README.md for discoverability
