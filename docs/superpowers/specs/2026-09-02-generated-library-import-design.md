# Generated Library Import Design

## Goal

Load the four ignored generation packages from `.local` into the local Payload CMS without creating duplicate canonical cards. The finished CMS library must represent 1,021 unique source illustrations. Fifty pilot cards already exist, so this operation creates at most 971 cards and their image records.

## Approved product decision

The user selected option 1 on 2026-09-02: one SHA-256 of the text-free source illustration equals one canonical card and one `/otkrytki/<slug>` URL.

- All 1,150 manifest rows participate in planning and audit output.
- The 49 pilot illustrations repeated in `popular-top10-2026-08` reuse the existing pilot cards, even when the later JPEG has different overlaid copy.
- The 80 Soviet illustrations repeated in the popular packages use the popular-package row as the representative card and do not create Soviet duplicates.
- The one pilot-only illustration remains represented by its existing pilot card.
- The resulting identity count is 1,021 cards: 50 existing pilot cards plus 971 new cards.

This decision intentionally treats a changed greeting over the same source illustration as another rendition, not another canonical content item.

## Source contract

The importer accepts these packages below one explicit asset root:

| Package | Manifest rows | Priority when choosing a representative |
| --- | ---: | ---: |
| `pilot-2026-08` | 50 | existing card wins; never rewritten |
| `popular-top10-2026-08` | 500 | 1 |
| `popular-next10-2026-08` | 500 | 2 |
| `soviet-holidays-2026-08` | 100 | 3 |

Every manifest row must resolve to a readable PNG source and portrait JPEG. A square JPEG is validated when declared but is not uploaded: the current CMS has one image relation per card and the square file is a rendition, not a second card. The PNG and square JPEG remain in `.local`, outside Git.

The preflight must prove the declared totals and fail closed if they drift:

- 1,150 manifest rows;
- 1,021 distinct source PNG SHA-256 values;
- 50 pilot rows;
- 49 pilot source hashes repeated outside the pilot package;
- 80 Soviet source hashes repeated in a popular package;
- 971 creation candidates after matching the 50 existing pilot cards.

## Content identity and representative selection

The full lowercase SHA-256 of the PNG bytes is the stable source identity. New hidden import keys use the namespace `generated-library-2026-08` and retain the full hash:

```text
generated-library-2026-08:image:<sha256>
generated-library-2026-08:card:<sha256>
generated-library-2026-08:collection:<collection-key>
```

The keys are accepted only through a trusted Payload Local API context bound to the `ai-editor` actor. REST and GraphQL clients cannot assign or replace them. Existing `pilotImportKey` values remain unchanged for backwards compatibility.

For a non-pilot duplicate group the representative is chosen deterministically by package priority, then manifest order. Its portrait `finalPath` supplies the uploaded bytes and its copy supplies the card metadata. Every discarded row is listed in the import report with the representative identity.

## Taxonomy

Existing approved pilot collection paths are reused. Eleven new leaf collections are created only when missing:

```text
/otkrytki/prazdniki/den-rozhdeniya/mame
/otkrytki/prazdniki/den-rozhdeniya/podruge
/otkrytki/prazdniki/1-maya
/otkrytki/prazdniki/den-materi
/otkrytki/prazdniki/den-svadby
/otkrytki/prazdniki/den-uchitelya
/otkrytki/prazdniki/paskha
/otkrytki/prazdniki/rozhdenie-malysha
/otkrytki/prazdniki/rozhdestvo
/otkrytki/prazdniki/yubiley
/otkrytki/pozhelaniya/spasibo
```

They start as `draft` with `noindex,follow`. Their content is complete, the existing server hook assigns the default human `admin` as responsible editor according to decision Ch-16, and their related links point to the parent plus sibling topics. The importing `ai-editor` remains the audited operation author but never replaces the server-authoritative responsible editor. Collections may move to `review`, but never to `published` and never to `index,follow`.

Styles, including the Soviet style, do not create collections or URLs.

## Card metadata

The importer derives complete, deterministic fields from the representative manifest row:

- `slug`: validated portrait JPEG filename stem. The only legacy exception is the Soviet package, whose files are named `01.jpg`…`20.jpg`; a unique Soviet-only illustration receives `<theme-slug>-sovetskaya-<ordinal>` (for example `otkrytka-1-maya-sovetskaya-01`). Any other numeric-only name or collision is a blocking error, never an automatic URL rewrite;
- `title` and `h1`: natural topic and visual description, made unique without dates or database IDs;
- `alt`: the manifest alt verbatim;
- `caption`: manifest headline followed by the wish;
- `description`: a natural visible sentence combining the visual description and greeting;
- `metaDescription`: a separate concise sentence, unique across the imported set;
- `usageTerms`: left empty because legal wording has not been approved;
- `collections`: the single primary leaf collection for the manifest theme;
- `status`: created as `draft`, then promoted to `review` only through the normal hooks;
- `robots`: always `noindex,follow`.

The preflight rejects empty fields, duplicate normalized title/H1/meta description values, invalid or repeated slugs, filenames longer than 68 characters, slugs longer than 80 characters, unknown themes, missing collection paths, and any final path collision.

## Apply and recovery

Dry-run is mandatory and performs zero writes. Apply recomputes the complete preflight fingerprint immediately before the first mutation. If manifests, asset bytes, actor, existing import identities, slugs, or collection paths changed, apply stops before writing.

Creation is resumable:

1. Reuse or create required collections in parent-first order.
2. Reuse or create one `card-images` record per source identity using the representative portrait JPEG.
3. Reuse or create one draft card bound to the image and primary collection.
4. Attempt the normal `draft` to `review` transition.
5. Leave a card in `draft` and record the exact refusal when pHash or another server rule requires editor judgment.
6. Verify all managed fields, permanent path claims, image revisions, statuses, and `noindex,follow` after the write.

No imported or pre-existing record is published. No sitemap or robots state is changed. Existing published pilot cards are read for identity only and are not edited.

## Operational report

The ignored JSON report records source totals, unique hashes, duplicate groups, representative choices, existing pilot reuse, created/resumed counts, review/draft counts, errors, and the invariant counters `published=0`, `indexed=0`, `sitemapUrlsAdded=0` for records created by this run.

The human-facing report states which cards remain in `draft`, why they could not reach `review`, and that publication remains an administrator action.

## Non-goals

- Publishing cards or collections.
- Enabling `index,follow`.
- Creating a second CMS image for square JPEGs.
- Changing existing pilot copy, slugs, images, or statuses.
- Guessing a style or mood taxonomy not approved by the project.
- Moving `.local` assets into Git.
