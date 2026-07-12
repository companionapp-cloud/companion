# PostHog post-wizard report

The wizard has completed a PostHog integration for the Companion marketing/docs website (`apps/website`). This is a web-only Expo Router app. The SDK (`posthog-react-native`) is initialized in `src/config/posthog.ts` and the `PostHogProvider` wraps the root layout, enabling the `usePostHog()` hook across all pages and components. Screen views are tracked automatically on route changes via `posthog.screen()` in `app/_layout.tsx`. Nine custom events are now instrumented across six files.

| Event name | Description | File |
|---|---|---|
| `contact_form_submitted` | User submits the contact form | `src/components/ContactForm.tsx` |
| `contact_type_selected` | User selects a request type (help / feature / other) | `src/components/ContactForm.tsx` |
| `feature_tab_clicked` | User clicks a feature showcase tab (Ask AI, Notes, Tasks, Habits) | `src/components/FeatureShowcase.tsx` |
| `doc_feedback_submitted` | User rates a docs article as helpful or not | `src/components/FeedbackRow.tsx` |
| `hero_cta_clicked` | User clicks a hero CTA button (Get started / Learn more) | `app/index.tsx` |
| `github_repo_clicked` | User clicks the Star on GitHub link | `app/index.tsx` |
| `docs_search_result_clicked` | User clicks a result from the docs search | `src/components/DocsSearch.tsx` |
| `doc_article_opened` | User opens a docs article from the homepage index | `src/components/DocsIndex.tsx` |
| `doc_related_article_clicked` | User clicks a related article at the bottom of a docs page | `app/docs/[slug].tsx` |

## Next steps

Insights and dashboard built from these events:

- [Analytics basics (wizard) — Dashboard](https://us.posthog.com/project/508482/dashboard/1835060)
- [Contact form submissions — Insight](https://us.posthog.com/project/508482/insights/a8RzxDrV)
- [Landing → Docs conversion funnel — Insight](https://us.posthog.com/project/508482/insights/mOZ42K0Z)
- [Feature showcase engagement — Insight](https://us.posthog.com/project/508482/insights/wKPKf6tm)
- [Docs feedback helpfulness — Insight](https://us.posthog.com/project/508482/insights/uQH9JL8q)
- [GitHub repo clicks & hero CTAs — Insight](https://us.posthog.com/project/508482/insights/V9zTyzXF)

## Verify before merging

- [ ] Run a full production build (`npm run build` from `apps/website`) and fix any lint or type errors introduced by the generated code.
- [ ] Run the test suite — call sites that were rewritten or instrumented may need updated mocks or fixtures.
- [ ] Add `POSTHOG_PROJECT_TOKEN` and `POSTHOG_HOST` to `.env.example` and any monorepo/bootstrap scripts so collaborators know what to set.
- [ ] Wire source-map upload (`posthog-cli sourcemap` or your bundler's upload step) into CI so production stack traces de-minify.

### Agent skill

We've left an agent skill folder in your project at `.claude/skills/integration-expo/`. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.
