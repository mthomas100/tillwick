// Auth for every process that talks to Claude (citizens, citizen0, auth-test). The default is an
// Anthropic API key (ANTHROPIC_API_KEY), as the Agent SDK docs describe:
// https://code.claude.com/docs/en/agent-sdk/quickstart
// A logged-in Claude subscription (CLAUDE_CODE_OAUTH_TOKEN, or the CLI login with
// TILLWICK_USE_CLAUDE_LOGIN=1) is an explicit opt-in for personal local experiments only.
export function checkAuth(tag: string): void {
  if (process.env.ANTHROPIC_API_KEY) {
    console.log(`[${tag}] auth: ANTHROPIC_API_KEY (Claude API)`);
    return;
  }
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.TILLWICK_USE_CLAUDE_LOGIN === "1") {
    console.warn(`[${tag}] auth: Claude subscription login (opt-in, personal local experiments only)`);
    return;
  }
  console.error(
    `[${tag}] no ANTHROPIC_API_KEY. Put one in .env (the default). For personal local experiments you can ` +
      `opt in to a logged-in Claude subscription instead: TILLWICK_USE_CLAUDE_LOGIN=1 (or CLAUDE_CODE_OAUTH_TOKEN).`,
  );
  process.exit(1);
}
