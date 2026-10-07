/** Image of the node agent (spec section 9). */
export const AGENT_IMAGE = 'ghcr.io/jenspenneman/launchway-agent';

/** `https://host` -> `wss://host`, `http://host` -> `ws://host` (origin only). */
export function agentServerUrl(origin: string): string {
  const url = new URL(origin);
  const scheme = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${url.host}`;
}

/** Image tag matching the control plane: release versions and `edge`, otherwise `latest`. */
export function agentImageTag(version: string): string {
  return /^\d+\.\d+\.\d+$/.test(version) || version === 'edge' ? version : 'latest';
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface JoinInstructionsInput {
  readonly serverUrl: string;
  readonly token: string;
  readonly version: string;
  readonly expiresAt: Date;
}

/**
 * Ready-made commands for a new node, following the conventions of deploy/compose.agent.yaml:
 * host networking (LAN address detection), the Docker socket, a named volume for the workspace
 * and the stored node credential.
 */
export function joinInstructions(input: JoinInstructionsInput): {
  dockerRunCommand: string;
  composeSnippet: string;
} {
  const image = `${AGENT_IMAGE}:${agentImageTag(input.version)}`;
  const dockerRunCommand = [
    // The agent gives running deployments 20 s to report after SIGTERM.
    'docker run -d --name launchway-agent --restart unless-stopped --init --stop-timeout 30',
    '  --network host --cap-drop ALL --security-opt no-new-privileges:true',
    `  -e LAUNCHWAY_SERVER_URL=${shellQuote(input.serverUrl)}`,
    `  -e LAUNCHWAY_JOIN_TOKEN=${shellQuote(input.token)}`,
    '  -e LAUNCHWAY_WORKSPACE=/var/lib/launchway',
    '  -v /var/run/docker.sock:/var/run/docker.sock',
    '  -v launchway-agent-data:/var/lib/launchway',
    `  ${image}`,
  ].join(' \\\n');

  const composeSnippet = `# compose.agent.yaml - start it with: docker compose -f compose.agent.yaml up -d
# The join token is single-use and valid until ${input.expiresAt.toISOString()}.
# After the first start the agent keeps a node credential in the agent-data volume;
# LAUNCHWAY_JOIN_TOKEN can then be removed.
name: launchway-agent

services:
  launchway-agent:
    image: ${image}
    restart: unless-stopped
    init: true
    # Running deployments get 20 s to report after SIGTERM.
    stop_grace_period: 30s
    # Host networking lets the agent detect the node's LAN address.
    network_mode: host
    cap_drop: [ALL]
    security_opt:
      - no-new-privileges:true
    environment:
      LAUNCHWAY_SERVER_URL: ${JSON.stringify(input.serverUrl)}
      LAUNCHWAY_JOIN_TOKEN: ${JSON.stringify(input.token)}
      LAUNCHWAY_WORKSPACE: /var/lib/launchway
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - agent-data:/var/lib/launchway

volumes:
  agent-data:
`;
  return { dockerRunCommand, composeSnippet };
}
