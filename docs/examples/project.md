## Product notes

<!-- Miu appends this file to the agent's instructions. Replace the examples
with your product's own facts and rules, or delete what does not apply. -->

### Combos

A = the plugin alone. B = the plugin with its Pro add-on, licensed (the licence steps are in `context/profile.json` under `licence`). The plugin's own wp-cli commands are `wp my-plugin ...`.

### Business rules

- Pro features fail closed without a valid licence, never open.
- No outbound HTTP or telemetry before the site owner opts in.
- The plugin never changes another plugin's settings or files.
