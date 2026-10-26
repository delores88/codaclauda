/* Conversation routing shared by the City panel and its tests. Addresses and labels are
 * display/routing data, never permission. Session sends use the same owner path as Chat. */
export function talkRoute(agent, store) {
  if (agent?.kind === 'session' || agent?.sessionId || String(agent?.id).startsWith('sess:')) {
    const sessionId = agent.sessionId || String(agent.id).slice(5);
    return { kind: 'session', sessionId, id: `sess:${sessionId}` };
  }
  if (agent?.address) return { kind: 'mailbox', address: agent.address, id: `mail:${agent.address}` };
  if (agent?.kind === 'external') return { kind: 'external', id: agent.id };
  const endpointId = agent?.endpointId || (String(agent?.id).startsWith('endpoint:') ? String(agent.id).slice(9) : null);
  if (endpointId) return { kind: 'live', endpointId, id: store?.threads?.().find(t => t.kind === 'live' && t.agentId === `endpoint:${endpointId}`)?.id || null };
  // An unknown id is not a board address. Keep the draft until an explicit route exists.
  return { kind: 'external', id: agent?.id || '' };
}

export function talkProject(agent, store) {
  for (const id of [agent?.cityProjectId, agent?.currentProjectId, agent?.lastKnownProjectId, agent?.homeProjectId]) {
    const project = id && store.project(id);
    if (project) return project;
  }
  return null;
}

/** Display-log items become the panel's existing owner/agent/system rows, including streamed text. */
export function talkMessages(items) {
  return (Array.isArray(items) ? items : []).map((item, index) => ({
    ...item, id: item.key || item.id || `line:${index}`,
    role: item.kind === 'owner' || item.kind === 'agent' ? item.kind : item.role || 'system',
    text: item.kind === 'tools' ? (item.tools || []).map(t => `${t.name}: ${t.summary || ''}`).join('\n')
      : item.kind === 'wake' ? `${item.from || 'Agent'}: ${item.subject || ''}${item.body ? `\n${item.body}` : ''}` : String(item.text || ''),
    state: item.streaming ? 'running' : 'completed',
  }));
}

export async function sendTalkSession(client, route, text) {
  if (route?.kind !== 'session' || !route.sessionId) throw new Error('This conversation has no managed session.');
  return client.send(route.sessionId, text);
}

/** Existing owner-approved labelled-copy command; never resumes or writes the desktop original. */
export async function continueTalkCopy(agent, project, { call, client }) {
  if (!agent?.providerSessionId || !agent?.cwd || !['claude', 'codex'].includes(agent.provider)) {
    throw new Error('This conversation has no copy route. Open Chat to start a session in this project.');
  }
  const data = await call('adopt', { provider: agent.provider, providerSessionId: agent.providerSessionId,
    cwd: agent.cwd, title: `${project?.name || agent.projectHint || agent.name || 'Conversation'} (copy)`, mode: 'fork' });
  return client.adopt(data, 'The conversation copy did not start.');
}
