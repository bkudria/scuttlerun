/**
 * Detect a leading slash-command prompt that the session cannot resolve.
 *
 * scuttlerun forwards the prompt verbatim to the Agent SDK. A slash command
 * (e.g. `/plugin:skill …`) only does anything when the defining skill/plugin
 * is loaded and registered in the session — otherwise the agent receives it as
 * literal text and typically does nothing (zero turns). This helper lets the
 * runner warn about that misconfiguration instead of failing silently.
 *
 * Returns the leading command token (without the leading slash, e.g.
 * `plugin:skill`) when the prompt begins with a well-formed slash command that
 * is NOT in `registered`; returns null when the prompt is not a slash command
 * or the command is registered.
 *
 * `registered` is the SDK `system/init` `slash_commands` list (entries carry no
 * leading slash). A leading token immediately followed by `/` (e.g. a file path
 * such as `/etc/hosts`) is treated as literal text, not a command.
 */
export function unregisteredSlashCommand(prompt: string, registered: string[]): string | null {
  const match = /^\/([A-Za-z0-9_:-]+)(?=\s|$)/.exec(prompt);
  if (!match) return null;
  const command = match[1];
  return registered.includes(command) ? null : command;
}

/**
 * The stderr warning for a prompt whose leading slash command is not
 * registered, or null when there is nothing to warn about.
 */
export function unresolvedSlashCommandWarning(prompt: string, registered: string[]): string | null {
  const command = unregisteredSlashCommand(prompt, registered);
  if (!command) return null;
  const sorted = registered.slice().sort();
  return (
    `[scuttlerun] WARNING: prompt begins with slash command "/${command}" ` +
    `which is not registered in this session, so the agent will receive it as literal ` +
    `text and likely do nothing. Load the defining skill/plugin via project.skills, ` +
    `project.plugins, or sdk.plugins. Registered slash commands: ` +
    `${sorted.join(', ') || '(none)'}\n`
  );
}
