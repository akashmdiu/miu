# Profiles

Miu tests a repository only if it has a profile: one JSON file per repository in the profiles folder. On a server that folder is `/etc/miu/profiles`. Anywhere else it is `profiles/` in Miu's folder, or the folder `MIU_PROFILES` names.

The quickest way to get one: on the dashboard's **GitHub** page, press **Make a profile**. Miu reads the repository and finds the plugin's main file, the default branch and the test scripts in `composer.json` and `package.json`. Then press **Edit** beside it to add what it cannot guess. The product notes (`project.md`, below) are under **Settings → Instructions → Product notes**. Both apply from the next run, with no restart.

## A plugin

```json
{
  "repo": "acme/shop",
  "role": "main",
  "label": "Shop",
  "slug": "shop",
  "main_file": "shop.php",
  "base_branch": "main",
  "combos": ["A"],
  "read_first": ["README.md", "CONTRIBUTING.md"],
  "fast_checks": [
    { "label": "PHPUnit", "cmd": "composer test", "when": "\\.php$" },
    { "label": "Build", "cmd": "npm run build", "when": "^src/|package(-lock)?\\.json$" }
  ],
  "triage": {
    "docs_only": "^(docs/|.*\\.md$|\\.github/)",
    "ui": "^(src/|assets/)"
  },
  "built_ui": { "source": "^src/", "built": "^assets/build/" }
}
```

| Field | Meaning |
|---|---|
| `repo` | `owner/name` on GitHub. Required. |
| `role` | `main` for a plugin, `addon` for a plugin that runs on top of another (a Pro add-on), `app` for a service the plugins talk to. The default is `main`. |
| `label` | The short name the dashboard and the reports use. |
| `slug` | The plugin's folder name in `wp-content/plugins`. The default is the repository name. |
| `main_file` | The file with the `Plugin Name:` header. The default is `<slug>.php`. |
| `base_branch` | The branch the "before" site runs, and the branch pull requests merge into. |
| `combos` | Which set-ups to test. `A` is the plugin alone. The product notes say what any other combo means. |
| `read_first` | Files the agent reads before it starts: contributor guides, architecture notes, rules. |
| `fast_checks` | The repository's own tests. Miu runs them beside the agent on the pull request's code, once a changed file matches `when`. A failure is run again on the base branch, so a failure that is already there is not blamed on the pull request. |
| `triage` | Regular expressions on changed paths. `docs_only` gives a short run with no sites when every file matches it. The other keys name areas for the agent. |
| `built_ui` | For a repository that commits its built files. If a pull request changes `source` without changing `built`, the agent reports it. |
| `licence` | Optional. How to license the add-on on a test site, in words for the agent: the options to set, for example. |
| `cross_repo` | Optional. What the agent should check across repositories, in words. |
| `not_in_ci` | Optional. Things the QA machine cannot cover. The report lists them as not covered. |

## A plugin and its add-on

Give the add-on its own profile with `"role": "addon"`, and point each profile at the other with `sibling`:

```json
{ "repo": "acme/shop-pro", "role": "addon", "label": "Pro", "slug": "shop-pro",
  "sibling": { "repo": "acme/shop", "label": "Free", "slug": "shop" },
  "combos": ["B", "B-unlicensed", "C"], "licence": "Set the option shop_pro_license_status to valid with wp option update." }
```

Two pull requests are tested together when their branches have the same name, or when one names the other in its body (`acme/shop-pro#12`, or `Pro #12`, using the profile's `label`). The "after" site runs both pull requests and the "before" site runs both base branches. Each pull request gets its own comment and verdict.

## project.json and project.md

These files sit beside the profiles and hold what the repositories share.

```json
{
  "name": "Shop",
  "marker": "miu",
  "cloudinary_folder": "miu",
  "slack_channel": null,
  "live_hosts": ["api.shop.example", "license.shop.example"],
  "reset_dirs": ["shop-cache"],
  "reset_upload_prefix": "shop"
}
```

| Field | Meaning |
|---|---|
| `marker` | Written into every comment Miu posts, so it can find its own comments later. Keep it the same once Miu has posted. |
| `cloudinary_folder` | The Cloudinary folder for screenshots. |
| `slack_channel` | Optional. A one-line notice goes here when a report is posted. It also needs `SLACK_USER_TOKEN`. |
| `live_hosts` | Your production services. The test sites refuse to reach them and log each attempt as evidence, and the agent is told never to contact them. A licence server belongs here. |
| `reset_dirs`, `reset_upload_prefix` | What your plugin writes under `wp-content` and `wp-content/uploads`. A site reset removes them. |

`project.md` holds your product's notes, added to the end of the agent's instructions: what each combo is, the plugin's wp-cli commands, and the business rules every pull request must follow. [examples/project.md](examples/project.md) is a starting point.
